// 鄱阳湖水体分析系统 - 主应用逻辑
let map;
let chart;
let eeInitialized = false;

// 初始化地图
function initMap() {
  try {
    map = L.map('map').setView([29.0, 116.3], 8);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
    
    // 添加Google卫星图层
    L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
      attribution: 'Google Satellite'
    }).addTo(map);
    
    return true;
  } catch (error) {
    updateStatus("地图初始化失败: " + error.message, true);
    return false;
  }
}

// 初始化GEE
function initGEE() {
  return new Promise((resolve, reject) => {
    if (typeof ee === 'undefined') {
      reject(new Error('Earth Engine API未加载'));
      return;
    }
    
    ee.initialize(
      null,
      null,
      () => {
        eeInitialized = true;
        updateStatus("GEE初始化成功");
        resolve();
      },
      (error) => {
        updateStatus(`GEE初始化失败: ${error.message}`, true);
        reject(error);
      }
    );
  });
}

// 更新状态显示
function updateStatus(message, isError = false) {
  const statusDiv = document.getElementById('status');
  if (!statusDiv) return;
  
  statusDiv.textContent = message;
  statusDiv.className = isError ? 'status-error' : 'status-info';
  
  if (isError) {
    console.error(message);
  } else {
    console.log(message);
  }
}

// 获取鄱阳湖边界
function getPoyangLakeBoundary() {
  return ee.FeatureCollection("users/public/poyang_lake_boundary").first().geometry();
}

// 计算水体指数
function calculateWaterIndices(image) {
  // 计算各种水体指数
  var ndwi = image.normalizedDifference(['B3', 'B8']).rename('NDWI');
  var mndwi = image.normalizedDifference(['B3', 'B11']).rename('mNDWI');
  var ndvi = image.normalizedDifference(['B8', 'B4']).rename('NDVI');
  var evi = image.expression(
    '2.5 * ((NIR - RED) / (NIR + 6 * RED - 7.5 * BLUE + 1))', {
      'NIR': image.select('B8'),
      'RED': image.select('B4'),
      'BLUE': image.select('B2')
    }).rename('EVI');
  
  return image.addBands(ndwi).addBands(mndwi).addBands(ndvi).addBands(evi);
}

// 创建水体掩膜
function createWaterMask(image) {
  return image.expression(
    '((mNDWI > EVI) && (mNDWI > NDVI) && (EVI < 0.1)) ? 1 : 0', {
      'mNDWI': image.select('mNDWI'),
      'NDVI': image.select('NDVI'),
      'EVI': image.select('EVI')
    }).rename('water');
}

// 获取时间序列数据
function getTimeSeries(startYear, endYear) {
  var poyang = getPoyangLakeBoundary();
  
  // 创建年份列表
  var years = ee.List.sequence(startYear, endYear);
  var months = ee.List.sequence(1, 12);
  
  // 对每年每月处理
  var timeSeries = ee.FeatureCollection(years.map(function(year) {
    return months.map(function(month) {
      var startDate = ee.Date.fromYMD(year, month, 1);
      var endDate = startDate.advance(1, 'month');
      
      // 获取当月影像
      var monthlyImage = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(poyang)
        .filterDate(startDate, endDate)
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
        .map(calculateWaterIndices)
        .median();
      
      // 计算水体频率
      var waterMask = createWaterMask(monthlyImage);
      var waterArea = waterMask.multiply(ee.Image.pixelArea()).reduceRegion({
        reducer: ee.Reducer.sum(),
        geometry: poyang,
        scale: 100,
        maxPixels: 1e13
      }).get('water');
      
      return ee.Feature(null, {
        'system:time_start': startDate.millis(),
        'date': startDate.format('YYYY-MM'),
        'FM': waterArea,
        'year': year,
        'month': month
      });
    });
  }).flatten());
  
  return timeSeries;
}

// 运行分析
async function analyzePoyangLake() {
  if (!eeInitialized) {
    updateStatus("GEE未初始化", true);
    return;
  }

  try {
    const yearRange = document.getElementById('year-range').value.split('-');
    const startYear = parseInt(yearRange[0]);
    const endYear = parseInt(yearRange[1]);
    
    updateStatus(`正在分析${startYear}-${endYear}年鄱阳湖水体...`);
    
    // 获取时间序列数据
    const timeSeries = getTimeSeries(startYear, endYear);
    
    // 获取数据用于图表
    const dates = await getEEData(timeSeries, 'date');
    const fmValues = await getEEData(timeSeries, 'FM');
    
    // 季节性分解（使用简单的移动平均）
    const trend = calculateMovingAverage(fmValues, 12);
    const seasonal = calculateSeasonalComponent(fmValues, trend);
    const residual = calculateResidual(fmValues, trend, seasonal);
    
    // 渲染图表
    renderChart(
      dates,
      fmValues,
      trend,
      seasonal,
      residual
    );
    
    // 显示最新水体影像
    await displayLatestWaterMap();
    
    updateStatus(`分析完成 (${startYear}-${endYear})`);
  } catch (error) {
    updateStatus(`分析失败: ${error.message}`, true);
  }
}

// 从GEE获取数据
function getEEData(eeObject, property) {
  return new Promise((resolve, reject) => {
    eeObject.aggregate_array(property).evaluate((result, error) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

// 计算移动平均（趋势）
function calculateMovingAverage(data, windowSize) {
  const halfWindow = Math.floor(windowSize / 2);
  const trend = [];
  
  for (let i = 0; i < data.length; i++) {
    let sum = 0;
    let count = 0;
    
    for (let j = Math.max(0, i - halfWindow); j <= Math.min(data.length - 1, i + halfWindow); j++) {
      sum += data[j];
      count++;
    }
    
    trend.push(sum / count);
  }
  
  return trend;
}

// 计算季节性成分
function calculateSeasonalComponent(data, trend) {
  const seasonal = [];
  const monthlyAverages = Array(12).fill(0);
  const monthlyCounts = Array(12).fill(0);
  
  // 计算每月平均
  for (let i = 0; i < data.length; i++) {
    const month = i % 12;
    monthlyAverages[month] += (data[i] - trend[i]);
    monthlyCounts[month]++;
  }
  
  for (let i = 0; i < 12; i++) {
    monthlyAverages[i] /= monthlyCounts[i];
  }
  
  // 创建季节性序列
  for (let i = 0; i < data.length; i++) {
    seasonal.push(monthlyAverages[i % 12]);
  }
  
  return seasonal;
}

// 计算残差
function calculateResidual(data, trend, seasonal) {
  return data.map((value, i) => value - trend[i] - seasonal[i]);
}

// 显示最新水体影像
async function displayLatestWaterMap() {
  try {
    const poyang = getPoyangLakeBoundary();
    
    // 获取最新影像
    const latestImage = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(poyang)
      .filterDate(ee.Date(Date.now()).advance(-3, 'month'), ee.Date(Date.now()))
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 10))
      .map(calculateWaterIndices)
      .median();
    
    // 计算水体掩膜
    const waterMask = createWaterMask(latestImage);
    
    // 获取地图ID
    const mapId = await new Promise((resolve, reject) => {
      waterMask.getMap({
        min: 0,
        max: 1,
        palette: ['white', 'blue']
      }, (mapId, error) => {
        if (error) reject(error);
        else resolve(mapId);
      });
    });
    
    // 添加到地图
    if (map && mapId) {
      map.eachLayer(layer => {
        if (layer.options && layer.options.attribution === 'Water Mask') {
          map.removeLayer(layer);
        }
      });
      
      const tileLayer = L.tileLayer(mapId.url, {
        attribution: 'Water Mask'
      }).addTo(map);
    }
  } catch (error) {
    console.error('显示水体影像失败:', error);
  }
}

// 渲染图表
function renderChart(labels, observed, trend, seasonal, residual) {
  const ctx = document.getElementById('water-chart').getContext('2d');
  
  if (chart) {
    chart.destroy();
  }
  
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: '观测值',
          data: observed,
          borderColor: '#4285F4',
          backgroundColor: 'rgba(66, 133, 244, 0.1)',
          fill: true,
          tension: 0.1
        },
        {
          label: '趋势',
          data: trend,
          borderColor: '#EA4335',
          borderWidth: 2,
          borderDash: [5, 5]
        },
        {
          label: '季节性',
          data: seasonal,
          borderColor: '#34A853',
          borderWidth: 1
        },
        {
          label: '残差',
          data: residual,
          borderColor: '#FBBC05',
          borderWidth: 1
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: '鄱阳湖水体频率时间序列分析'
        },
        tooltip: {
          mode: 'index',
          intersect: false
        }
      },
      scales: {
        x: {
          title: {
            display: true,
            text: '日期'
          },
          ticks: {
            maxRotation: 45,
            minRotation: 45
          }
        },
        y: {
          title: {
            display: true,
            text: '水体面积(平方米)'
          }
        }
      },
      interaction: {
        mode: 'nearest',
        axis: 'x',
        intersect: false
      }
    }
  });
}

// 初始化应用
async function initApp() {
  try {
    updateStatus("正在初始化系统...");
    
    // 初始化地图
    if (!initMap()) return;
    
    // 初始化GEE
    await initGEE();
    
    // 设置分析按钮事件
    document.getElementById('analyze-btn').addEventListener('click', analyzePoyangLake);
    
    // 设置年份范围选择器
    const currentYear = new Date().getFullYear();
    const yearSelect = document.getElementById('year-range');
    for (let year = 2015; year <= currentYear; year++) {
      const option = document.createElement('option');
      option.value = `${year}-${year}`;
      option.textContent = `${year}年`;
      yearSelect.appendChild(option);
    }
    yearSelect.value = `2015-${currentYear}`;
    
    updateStatus("系统准备就绪，请点击分析按钮开始");
    
  } catch (error) {
    updateStatus(`初始化失败: ${error.message}`, true);
  }
}

// 启动应用
window.addEventListener('load', initApp);
