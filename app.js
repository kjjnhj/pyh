// 全局变量
let map;
let chart;
const START_YEAR = 2020;
const END_YEAR = 2021;

// 主初始化函数
function init() {
  updateStatus("正在加载Earth Engine...");
  
  ee.initialize(
    null,
    null,
    () => {
      updateStatus("正在初始化地图...");
      initMap();
      initControls();
    },
    (error) => {
      if (error.message.includes('Not logged in')) {
        showAuthButton();
      } else {
        updateStatus(`初始化失败: ${error.message}`, true);
      }
    },
    { timeout: 15000 }
  );
}

// 初始化地图
function initMap() {
  try {
    map = new google.maps.Map(document.getElementById('map'), {
      center: { lat: 28.6, lng: 115.8 },
      zoom: 8,
      mapTypeId: 'hybrid'
    });
    
    loadBaseLayers();
    updateStatus("准备就绪");
    
  } catch (error) {
    updateStatus(`地图初始化错误: ${error.message}`, true);
  }
}

// 加载基础图层
function loadBaseLayers() {
  const region = ee.Geometry.Rectangle([115, 28, 117, 29]);
  
  // Sentinel-2影像
  const s2Image = ee.ImageCollection('COPERNICUS/S2_SR')
    .filterBounds(region)
    .filterDate(`${START_YEAR}-01-01`, `${END_YEAR}-12-31`)
    .median()
    .clip(region);
  
  // 水体掩膜
  const waterMask = calculateWaterMask(s2Image);
  
  // 添加到地图
  addEELayerToMap(s2Image, { bands: ['B4', 'B3', 'B2'], min: 0, max: 3000 }, 'Sentinel-2影像');
  addEELayerToMap(waterMask, { palette: ['blue'] }, '水体掩膜');
}

// 计算水体掩膜
function calculateWaterMask(image) {
  const ndwi = image.normalizedDifference(['B3', 'B8']).rename('NDWI');
  const mndwi = image.normalizedDifference(['B3', 'B11']).rename('MNDWI');
  const ndvi = image.normalizedDifference(['B8', 'B4']).rename('NDVI');
  const evi = image.expression(
    '2.5 * ((NIR - RED) / (NIR + 6 * RED - 7.5 * BLUE + 1))', {
      'NIR': image.select('B8'),
      'RED': image.select('B4'),
      'BLUE': image.select('B2')
    }).rename('EVI');
  
  return image.addBands(ndwi).addBands(mndwi).addBands(ndvi).addBands(evi)
    .expression(
      '((MNDWI > EVI) && (MNDWI > NDVI)) && EVI < 0.1 ? 1 : 0', {
        'MNDWI': image.select('MNDWI'),
        'EVI': image.select('EVI'),
        'NDVI': image.select('NDVI')
      }).rename('water');
}

// 添加EE图层到Google地图
function addEELayerToMap(image, visParams, layerName) {
  image.getMap(visParams, ({ mapid, token }) => {
    const tileUrl = `https://earthengine.googleapis.com/map/${mapid}/{z}/{x}/{y}?token=${token}`;
    
    const layer = new google.maps.ImageMapType({
      getTileUrl: (coord, zoom) => {
        return tileUrl
          .replace('{x}', coord.x)
          .replace('{y}', coord.y)
          .replace('{z}', zoom);
      },
      tileSize: new google.maps.Size(256, 256),
      name: layerName,
      opacity: 0.7
    });
    
    map.overlayMapTypes.push(layer);
  });
}

// 初始化控制面板
function initControls() {
  document.getElementById('analyze-btn').addEventListener('click', () => {
    runSeasonalAnalysis();
  });
}

// 运行季节性分析
function runSeasonalAnalysis() {
  updateStatus("正在计算水体频率...");
  
  const region = ee.Geometry.Rectangle([115, 28, 117, 29]);
  const spatialTiles = createSpatialGrid(region, 5);
  
  const timeSeries = generateTimeSeries(region);
  
  processTimeSeriesData(timeSeries);
}

// 创建空间网格
function createSpatialGrid(region, gridSize) {
  const bounds = region.bounds();
  const coords = bounds.coordinates().get(0);
  
  const lonStart = ee.Number(ee.List(coords).get(0).get(0);
  const latStart = ee.Number(ee.List(coords).get(0).get(1);
  const lonEnd = ee.Number(ee.List(coords).get(2).get(0);
  const latEnd = ee.Number(ee.List(coords).get(2).get(1);
  
  const lonStep = lonEnd.subtract(lonStart).divide(gridSize);
  const latStep = latEnd.subtract(latStart).divide(gridSize);
  
  return ee.FeatureCollection(
    ee.List.sequence(0, gridSize-1).map(i => {
      return ee.List.sequence(0, gridSize-1).map(j => {
        const minLon = lonStart.add(lonStep.multiply(i));
        const minLat = latStart.add(latStep.multiply(j));
        return ee.Feature(
          ee.Geometry.Rectangle([
            minLon, minLat,
            minLon.add(lonStep), minLat.add(latStep)
          ]),
          { tile_id: ee.Number(i).multiply(gridSize).add(j) }
        );
      });
    }).flatten()
  );
}

// 生成时间序列数据
function generateTimeSeries(region) {
  const collection = ee.ImageCollection('COPERNICUS/S2_SR')
    .filterBounds(region)
    .filterDate(`${START_YEAR}-01-01`, `${END_YEAR}-12-31`)
    .map(calculateWaterMask);
    
  const months = ee.List.sequence(1, 12);
  const years = ee.List.sequence(START_YEAR, END_YEAR);
  
  return ee.ImageCollection.fromImages(
    years.map(year => {
      return months.map(month => {
        const startDate = ee.Date.fromYMD(year, month, 1);
        const endDate = startDate.advance(1, 'month');
        
        const monthlyImage = collection
          .filterDate(startDate, endDate)
          .mosaic();
          
        return monthlyImage
          .set('system:time_start', startDate.millis())
          .set('year', year)
          .set('month', month);
      });
    }).flatten()
  );
}

// 处理时间序列数据
function processTimeSeriesData(timeSeries) {
  timeSeries.aggregate_array('system:time_start').evaluate(dates => {
    timeSeries.aggregate_array('water').evaluate(values => {
      renderSeasonalChart(dates, values);
      updateStatus("分析完成");
    }, handleError);
  }, handleError);
}

// 渲染季节性图表
function renderSeasonalChart(dates, values) {
  const ctx = document.getElementById('chart-container').getContext('2d');
  
  if (chart) {
    chart.destroy();
  }
  
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: dates.map(date => new Date(date).toLocaleDateString()),
      datasets: [{
        label: '水体覆盖率',
        data: values,
        borderColor: 'rgb(75, 192, 192)',
        tension: 0.1
      }]
    },
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: '鄱阳湖水体季节性变化'
        }
      },
      scales: {
        x: {
          title: { display: true, text: '日期' }
        },
        y: {
          title: { display: true, text: '水体覆盖率(%)' }
        }
      }
    }
  });
}

// 显示认证按钮
function showAuthButton() {
  const statusPanel = document.getElementById('status-panel');
  statusPanel.innerHTML = `
    <p>需要Earth Engine认证</p>
    <button id="auth-btn" style="padding: 8px 16px; margin-top: 10px;">
      点击进行认证
    </button>
  `;
  
  document.getElementById('auth-btn').addEventListener('click', () => {
    ee.authenticate(
      () => location.reload(),
      error => updateStatus(`认证失败: ${error.message}`, true)
    );
  });
}

// 更新状态
function updateStatus(message, isError = false) {
  const statusPanel = document.getElementById('status-panel');
  statusPanel.textContent = message;
  statusPanel.style.color = isError ? '#d32f2f' : '#2e7d32';
  statusPanel.style.backgroundColor = isError ? '#ffebee' : '#e8f5e9';
}

// 错误处理
function handleError(error) {
  console.error(error);
  updateStatus(`处理错误: ${error.message}`, true);
}

// 启动应用
window.addEventListener('load', init);