// 鄱阳湖水体分析系统 - 主应用逻辑
// 全局变量
let map;
let chart;
let eeInitialized = false;
let waterLayer = null;

// 调试函数
function debugLog(message) {
  const debugDiv = document.getElementById('debug');
  if (!debugDiv) return;
  
  const messageDiv = document.createElement('div');
  messageDiv.className = 'debug-message';
  messageDiv.textContent = `${new Date().toLocaleTimeString()}: ${message}`;
  debugDiv.appendChild(messageDiv);
  debugDiv.scrollTop = debugDiv.scrollHeight;
}

// 更新状态显示
function updateStatus(message, isError = false) {
  const statusDiv = document.getElementById('status');
  if (!statusDiv) return;
  
  statusDiv.textContent = message;
  statusDiv.className = isError ? 'status-error' : 'status-loading';
  debugLog(`状态更新: ${message}`);
}

// 初始化地图
function initMap() {
  try {
    map = L.map('map').setView([29.0, 116.3], 8);
    
    // 添加底图 (使用OpenStreetMap)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    
    // 添加鄱阳湖边界
    const poyangLakeBounds = [
      [29.6, 115.8],
      [29.6, 116.8],
      [28.6, 116.8],
      [28.6, 115.8]
    ];
    L.polygon(poyangLakeBounds, {color: '#ff7800', fillOpacity: 0}).addTo(map);
    
    debugLog("地图初始化成功");
    return true;
  } catch (error) {
    debugLog(`地图初始化错误: ${error.message}`);
    updateStatus("地图初始化失败", true);
    return false;
  }
}

// 初始化GEE
function initGEE() {
  return new Promise((resolve, reject) => {
    ee.initialize(
      null,
      null,
      () => {
        eeInitialized = true;
        debugLog("GEE初始化成功");
        resolve();
      },
      (error) => {
        debugLog(`GEE初始化错误: ${error.message}`);
        if (error.message.includes('Not logged in')) {
          showAuthButton();
        }
        reject(error);
      }
    );
  });
}

// 显示认证按钮
function showAuthButton() {
  updateStatus("需要Earth Engine认证");
  
  const statusDiv = document.getElementById('status');
  if (!statusDiv) return;
  
  const authBtn = document.createElement('button');
  authBtn.id = 'auth-btn';
  authBtn.textContent = '点击进行认证';
  statusDiv.appendChild(document.createElement('br'));
  statusDiv.appendChild(authBtn);
  
  authBtn.addEventListener('click', () => {
    debugLog("启动GEE认证流程");
    ee.data.authenticateViaPopup(
      () => {
        debugLog("认证成功，重新加载");
        location.reload();
      },
      (error) => {
        debugLog(`认证失败: ${error.message}`);
        updateStatus(`认证失败: ${error.message}`, true);
      }
    );
  });
}

// 分析鄱阳湖水体
function analyzePoyangLake() {
  if (!eeInitialized) {
    updateStatus("GEE未初始化", true);
    return;
  }
  
  const yearRange = document.getElementById('year-range').value.split('-');
  const startYear = parseInt(yearRange[0]);
  const endYear = parseInt(yearRange[1]);
  
  updateStatus(`正在分析${startYear}-${endYear}年鄱阳湖水体...`);
  debugLog(`开始分析: ${startYear}-${endYear}`);
  
  // 定义鄱阳湖区域
  const poyangLake = ee.Geometry.Polygon([
    [115.8, 29.6], [116.8, 29.6], [116.8, 28.6], [115.8, 28.6]
  ]);
  
  // 获取季节性水体数据
  getSeasonalWaterData(startYear, endYear, poyangLake)
    .then(renderResults)
    .catch(error => {
      debugLog(`分析错误: ${error.message}`);
      updateStatus("分析过程中出错", true);
    });
}

// 获取季节性水体数据
function getSeasonalWaterData(startYear, endYear, geometry) {
  return new Promise((resolve, reject) => {
    try {
      debugLog("准备GEE计算请求");
      
      // 加载Landsat 8地表反射率数据
      const collection = ee.ImageCollection('LANDSAT/LC08/C01/T1_SR')
        .filterBounds(geometry)
        .filterDate(ee.Date.fromYMD(startYear, 1, 1), ee.Date.fromYMD(endYear, 12, 31))
        .filter(ee.Filter.lt('CLOUD_COVER', 20));
      
      // 按月份分组计算
      const monthlyData = ee.List.sequence(1, 12).map(function(month) {
        month = ee.Number(month);
        // 获取该月的中值合成图像
        const monthlyImage = collection.filter(ee.Filter.calendarRange(month, month, 'month'))
          .median();
        
        // 计算水体面积
        const area = calculateWaterArea(monthlyImage, geometry);
        
        // 返回月份和水体面积
        return ee.Feature(null, {
          'month': month,
          'area': area,
          'month_name': ee.Date.fromYMD(startYear, month, 1).format('MMM')
        });
      });
      
      const waterData = ee.FeatureCollection(monthlyData);
      
      debugLog("提交GEE计算请求");
      waterData.evaluate(function(result) {
        if (result && result.features) {
          debugLog("成功获取分析结果");
          resolve(result.features);
        } else {
          reject(new Error("无法获取水体数据"));
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

// 计算水体面积
function calculateWaterArea(image, geometry) {
  // 计算MNDWI水体指数 (使用绿波段和短波红外波段)
  const mndwi = image.normalizedDifference(['B3', 'B6']).rename('MNDWI');
  
  // 应用阈值提取水体
  const water = mndwi.gt(0.2);
  
  // 计算水体面积 (平方米)
  const area = water.multiply(ee.Image.pixelArea()).reduceRegion({
    reducer: ee.Reducer.sum(),
    geometry: geometry,
    scale: 30,
    maxPixels: 1e12
  }).get('MNDWI');
  
  return area;
}

// 渲染结果
function renderResults(data) {
  try {
    debugLog("开始渲染结果");
    
    // 处理数据
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const processedData = data.map(feature => {
      const props = feature.properties;
      return {
        month: props.month,
        monthName: monthNames[props.month - 1],
        area: props.area / 1000000 // 转换为平方公里
      };
    });
    
    // 渲染图表
    renderChart(processedData);
    
    // 渲染地图
    renderMap(data[0].properties.year || new Date().getFullYear());
    
    updateStatus("分析完成");
    debugLog("结果渲染完成");
  } catch (error) {
    debugLog(`渲染错误: ${error.message}`);
    updateStatus("结果渲染失败", true);
  }
}

// 渲染图表
function renderChart(data) {
  const ctx = document.getElementById('water-chart').getContext('2d');
  
  // 如果已有图表，先销毁
  if (chart) {
    chart.destroy();
  }
  
  // 准备数据
  const labels = data.map(d => d.monthName);
  const areaData = data.map(d => d.area);
  
  // 创建新图表
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: '水体面积 (平方公里)',
        data: areaData,
        borderColor: '#1a73e8',
        backgroundColor: 'rgba(26, 115, 232, 0.1)',
        fill: true,
        tension: 0.3
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
          title: {
            display: true,
            text: '月份'
          }
        },
        y: {
          title: {
            display: true,
            text: '水体面积 (km²)'
          },
          min: 0
        }
      }
    }
  });
}

// 渲染地图 (简化版，实际需要GEE的getMap URL)
function renderMap(year) {
  debugLog(`渲染${year}年水体分布图`);
  
  // 这里应该是从GEE获取地图瓦片URL并添加到Leaflet地图
  // 由于需要GEE的getMap功能，这里只是示例
  
  if (waterLayer) {
    map.removeLayer(waterLayer);
  }
  
  // 示例: 添加一个透明的水体示意层
  waterLayer = L.rectangle([
    [29.3, 116.0],
    [28.8, 116.5]
  ], {
    color: '#1a73e8',
    fillColor: '#1a73e8',
    fillOpacity: 0.5,
    weight: 1
  }).addTo(map);
  
  waterLayer.bindPopup(`${year}年鄱阳湖水体分布示意`).openPopup();
}

// 初始化应用
async function initApp() {
  try {
    debugLog("开始初始化应用");
    updateStatus("正在初始化系统...");
    
    // 初始化地图
    if (!initMap()) {
      throw new Error("地图初始化失败");
    }
    
    // 初始化GEE
    await initGEE();
    
    // 设置分析按钮事件
    document.getElementById('analyze-btn').addEventListener('click', analyzePoyangLake);
    
    updateStatus("系统准备就绪");
    debugLog("应用初始化完成");
    
    // 默认运行一次分析
    analyzePoyangLake();
  } catch (error) {
    debugLog(`初始化错误: ${error.message}`);
    updateStatus(`初始化失败: ${error.message}`, true);
  }
}

// 启动应用
window.addEventListener('load', initApp);

// 暴露调试函数到全局
window.debugLog = debugLog;
