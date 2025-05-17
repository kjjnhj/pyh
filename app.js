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
    return true;
  } catch (error) {
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
  statusDiv.className = isError ? 'status-error' : 'status-loading';
}

// 运行分析
async function analyzePoyangLake() {
  if (!eeInitialized) {
    updateStatus("GEE未初始化", true);
    return;
  }

  const yearRange = document.getElementById('year-range').value.split('-');
  const startYear = parseInt(yearRange[0]);
  const endYear = parseInt(yearRange[1]);
  
  updateStatus(`正在分析${startYear}-${endYear}年鄱阳湖水体...`);
  
  try {
    // 调用GEE分析函数
    const analysisResults = await new Promise((resolve, reject) => {
      ee.data.computeValue(
        ee.Function.call('getAnalysisResults'),
        resolve,
        reject
      );
    });

    // 处理时间序列数据
    const timeseries = analysisResults.timeseries;
    const dates = await getPropertyArray(timeseries, 'system:time_start');
    const fmValues = await getPropertyArray(timeseries, 'FM');

    // 季节性分解
    const decomposition = science.sts.decompose(fmValues, 12);
    
    // 渲染图表
    renderChart(
      dates.map(date => new Date(date).toISOString().split('T')[0]),
      fmValues,
      decomposition.trend,
      decomposition.seasonal,
      decomposition.remainder
    );
    
    updateStatus("分析完成");
  } catch (error) {
    updateStatus(`分析失败: ${error.message}`, true);
  }
}

// 从GEE集合获取属性数组
function getPropertyArray(collection, property) {
  return new Promise((resolve, reject) => {
    collection.aggregate_array(property).evaluate((result, error) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
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
          fill: true
        },
        {
          label: '趋势',
          data: trend,
          borderColor: '#EA4335',
          borderDash: [5, 5]
        },
        {
          label: '季节性',
          data: seasonal,
          borderColor: '#34A853'
        },
        {
          label: '残差',
          data: residual,
          borderColor: '#FBBC05'
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: '水体频率季节性分解'
        }
      },
      scales: {
        x: {
          title: {
            display: true,
            text: '日期'
          }
        },
        y: {
          title: {
            display: true,
            text: '水体频率'
          }
        }
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
    
    updateStatus("系统准备就绪");
    
    // 默认运行一次分析
    analyzePoyangLake();
  } catch (error) {
    updateStatus(`初始化失败: ${error.message}`, true);
  }
}

// 启动应用
window.addEventListener('load', initApp);
