// ---- Utility: Color palette ----
const AUTO_COLORS1 = [
"#ef2f27",
"#ff5f00",
"#f5e502",
"#519f50",
"#0aaeb3",
"#11e3df",
"#2c78bf",
"#c7428f",
"#e02c6d",
"#f096b6"
];



const AUTO_COLORS = ["#00202e",
"#2c4875",
"#8a508f",
"#bc5090",
"#ff6361",
"#ff8531",
"#ffa600",
"#ffd380",
];

// ==================== Dark Histogram Panel Module ====================

let histogramPanelElements = {};


function computeHistogram(data, binCount = 10, minVal = null, maxVal = null) {
  if (!data || data.length === 0) return null;
  const minX = minVal !== null ? minVal : Math.min(...data);
  const maxX = maxVal !== null ? maxVal : Math.max(...data);
  const binSize = (maxX - minX) / binCount;
  const bins = new Array(binCount).fill(0);
  for (let v of data) {
    let idx = Math.floor((v - minX) / binSize);
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    bins[idx]++;
  }
  return { bins, minX, maxX, binSize };
}

export function removeHistogramPanel() {
  const panel = document.getElementById("histogramPanel");
  if (panel) panel.remove();
  if (histogramPanelElements.histogramPanel)
    histogramPanelElements.histogramPanel.remove();

}


export function addHistogramPanel(datasets, labels = [], xAxisLabel="Bond length in Å", yAxisLabel="Count") {
  if (histogramPanelElements.histogramPanel)
    histogramPanelElements.histogramPanel.remove();

  if (!labels || labels.length !== datasets.length) {
    labels = datasets.map((_, i) => "Dataset " + (i + 1));
  }

  const panel = document.createElement("div");
  panel.id = "HistogramPanel";
  panel.style.position = "absolute";
  panel.style.left = "20px";
  panel.style.top = "20px";
  panel.style.background = "#222";
  panel.style.border = "1px solid #555";
  panel.style.boxShadow = "0px 0px 8px rgba(0,0,0,0.6)";
  panel.style.borderRadius = "6px";
  panel.style.zIndex = 9999;
  panel.style.userSelect = "none";
  panel.style.color = "#eee";

  panel.innerHTML = `
    <div id="histHeader" style="padding:6px 10px; background:#333; cursor:move; font-weight:bold; border-bottom:1px solid #555; color:#fff;">
      Histogram <span id="histFoldToggle" style="float:right; cursor:pointer;">▼</span>
    </div>
    <div id="histBody" style="padding:10px; display:block;">
      <canvas id="histCanvas" width="600" height="300" style="border:1px solid #444; border-radius:4px; background:#111;padding-bottom: 10px;} "></canvas>
      <div id="histTooltip" style="position:absolute; pointer-events:none; padding:4px 6px; background:#000; color:#fff; border-radius:4px; font-size:12px; display:none; z-index:10000;"></div>
      <div style="display:flex; align-items:flex-start; justify-content:space-between; margin-top:8px;">
        <div id="histLegend" style="font-size:12px; color:#ddd; display:flex; flex-wrap:wrap; gap:8px; max-width:300px;"></div>
        <div style="color:#ddd; font-size:12px; display:flex; flex-direction:column; gap:4px;">

          <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px;">
            <label for="binSlider" style="width:70px; text-align:right;">Bins:</label>
            <input type="range" id="binSlider" min="2" max="30" value="5" style="flex:1;">
            <span id="binCountLabel" style="min-width:30px; text-align:right;">30</span>
          </div>

          <div style="display:flex; align-items:center; gap:6px;">
            <label for="maxSlider" style="width:70px; text-align:right;">Max Dist:</label>
            <input type="range" id="maxSlider" min="2" max="6" value="3" style="flex:1;">
            <span id="maxValLabel" style="min-width:30px; text-align:right;">6</span>
          </div>

        </div>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  const header = panel.querySelector("#histHeader");
  const body = panel.querySelector("#histBody");
  const canvas = panel.querySelector("#histCanvas");
  const legendBox = panel.querySelector("#histLegend");
  const foldToggle = panel.querySelector("#histFoldToggle");
  const tooltip = panel.querySelector("#histTooltip");
  const binSlider = panel.querySelector("#binSlider");
  const binCountLabel = panel.querySelector("#binCountLabel");
  const maxSlider = panel.querySelector("#maxSlider");
  const maxValLabel = panel.querySelector("#maxValLabel");
  const ctx = canvas.getContext("2d");

  histogramPanelElements = { histogramPanel: panel };

  // High-DPI scaling
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.width * dpr;
  canvas.height = canvas.height * dpr;
  canvas.style.width = (canvas.width / dpr) + "px";
  canvas.style.height = (canvas.height / dpr) + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = canvas.width / dpr;
  const H = canvas.height / dpr;

  const allValues = datasets.flat();
  const globalMin = Math.min(...allValues);
  let maxXValue = parseInt(maxSlider.value);

  let BINCOUNT = parseInt(binSlider.value);

  let histograms = datasets.map(ds => computeHistogram(ds, BINCOUNT, globalMin, maxXValue));

  const barRects = [];
  let selectedBar = null;

  const margin = 50;
  const plotW = W - margin*2;
  const plotH = H - margin*2;

  function drawHistogram() {
    const maxBinHeight = Math.max(...histograms.flatMap(h => h.bins));
    ctx.clearRect(0, 0, W, H);
    barRects.length = 0;

    const datasetCount = datasets.length;
    const groupCount = BINCOUNT;

    const binSpacing = 12;
    const barSpacing = 2;
    const totalBinWidth = (plotW - binSpacing*(groupCount-1)) / groupCount;
    const barWidth = (totalBinWidth - (datasetCount-1)*barSpacing)/datasetCount;

    ctx.strokeStyle = "#bbb"; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(margin, H - margin); ctx.lineTo(W - margin, H - margin); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(margin, margin); ctx.lineTo(margin, H - margin); ctx.stroke();

    for (let i = 0; i < groupCount; i++) {
      const groupStartX = margin + i*(totalBinWidth + binSpacing);
      for (let di = 0; di < datasetCount; di++) {
        const hist = histograms[di];
        const value = hist.bins[i];
        const barHeight = (value/maxBinHeight)*plotH;
        const x0 = groupStartX + di*(barWidth + barSpacing);
        const y0 = H - margin - barHeight;

        ctx.fillStyle = AUTO_COLORS[di % AUTO_COLORS.length];
        ctx.fillRect(x0, y0, barWidth, barHeight);
        ctx.strokeStyle = "rgba(255,255,255,.3)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x0, y0, barWidth, barHeight);

        if (selectedBar && selectedBar.dataset===di && selectedBar.bin===i) {
          ctx.strokeStyle = "rgba(255,255,255,.8)";
          ctx.lineWidth = 2;
          ctx.strokeRect(x0, y0, barWidth, barHeight);
        }

        barRects.push({
          x: x0*dpr, y: y0*dpr, width: barWidth*dpr, height: barHeight*dpr,
          dataset: di, bin: i, value
        });
      }
    }

    ctx.fillStyle = "#ddd"; ctx.font = "14px 'Segoe UI', sans-serif"; ctx.textAlign = "center";
    for (let i = 0; i < groupCount; i++) {
      const x = margin + i*(totalBinWidth + binSpacing) + totalBinWidth/2;
      const v = (globalMin + i*(maxXValue-globalMin)/BINCOUNT).toFixed(1);
      ctx.fillText(v, x, H - margin + 15);
    }

    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let y = 0; y <= maxBinHeight; y += Math.ceil(maxBinHeight/5)) {
      const yPix = H - margin - (y/maxBinHeight)*plotH;
      ctx.fillText(y, margin - 4, yPix);
    }

    ctx.fillStyle = "#ddd"; ctx.font = "14px 'Segoe UI', sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText(xAxisLabel, margin + plotW/2, H - margin + 35);

    ctx.save();
    ctx.translate(margin - 40, margin + plotH/2);
    ctx.rotate(-Math.PI/2);
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText(yAxisLabel, 0, 0);
    ctx.restore();
  }

  drawHistogram();

  legendBox.innerHTML = labels.map((lbl,i)=>`
    <div style="display:flex; align-items:center; width:70px;">
      <div style="width:12px; height:12px; background:${AUTO_COLORS[i % AUTO_COLORS.length]}; margin-right:6px; border:1px solid rgba(255,255,255,.3); "></div>
      <span style="color:#eee; font-size:12px;">${lbl}</span>
    </div>
  `).join("");

  binSlider.addEventListener("input", () => {
    BINCOUNT = parseInt(binSlider.value);
    binCountLabel.textContent = BINCOUNT;
    histograms = datasets.map(ds => computeHistogram(ds, BINCOUNT, globalMin, maxXValue));
    drawHistogram();
  });

  maxSlider.addEventListener("input", () => {
    maxXValue = parseInt(maxSlider.value);
    maxValLabel.textContent = maxXValue;
    histograms = datasets.map(ds => computeHistogram(ds, BINCOUNT, globalMin, maxXValue));
    drawHistogram();
  });

canvas.addEventListener("mousemove", e => {
  let found = false;

  const rect = canvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * dpr;
  const my = (e.clientY - rect.top) * dpr;

  for (let bar of barRects) {
    if (mx >= bar.x && mx <= bar.x + bar.width && my >= bar.y && my <= bar.y + bar.height) {
      found = true;

      tooltip.style.display = "block";


      const tooltipRect = tooltip.getBoundingClientRect();
      tooltip.style.left = "80px";
      tooltip.style.top = "80px";

      const binMin = (globalMin + bar.bin * (maxXValue - globalMin) / BINCOUNT).toFixed(2);
      const binMax = (globalMin + (bar.bin + 1) * (maxXValue - globalMin) / BINCOUNT).toFixed(2);
      tooltip.innerHTML = `${labels[bar.dataset]}<br>Range: ${binMin} - ${binMax}<br>Count: ${bar.value}`;

      break;
    }
  }

  if (!found) tooltip.style.display = "none";
});

// Click selection
canvas.addEventListener("click", e => {
  const rect = canvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * dpr;
  const my = (e.clientY - rect.top) * dpr;
  selectedBar = barRects.find(bar => mx >= bar.x && mx <= bar.x + bar.width && my >= bar.y && my <= bar.y + bar.height) || null;
  drawHistogram();
});


  canvas.addEventListener("mouseleave", ()=>tooltip.style.display="none");


  let dragging=false, offsetX=0, offsetY=0;
  header.addEventListener("mousedown", e => { if(e.target!==foldToggle){dragging=true; offsetX=e.clientX-panel.offsetLeft; offsetY=e.clientY-panel.offsetTop;}});
  document.addEventListener("mousemove", e => { if(dragging){panel.style.left=(e.clientX-offsetX)+"px"; panel.style.top=(e.clientY-offsetY)+"px";}});
  document.addEventListener("mouseup", ()=>dragging=false);

  foldToggle.onclick = () => {
    if(body.style.display==="none"){ body.style.display="block"; foldToggle.textContent="▼"; }
    else{ body.style.display="none"; foldToggle.textContent="▲"; }
  };
}




