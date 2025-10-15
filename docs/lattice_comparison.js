export function createLatticeComparisonPanel(L1_matrix, L2_matrix) {
  // --------------------------
  // Helper functions
  // --------------------------
  function length(v) { return Math.sqrt(v[0]**2 + v[1]**2 + v[2]**2); }
  function dot(u,v) { return u[0]*v[0]+u[1]*v[1]+u[2]*v[2]; }
  function cross(u,v) {
    return [
      u[1]*v[2]-u[2]*v[1],
      u[2]*v[0]-u[0]*v[2],
      u[0]*v[1]-u[1]*v[0]
    ];
  }
  function latticeParameters(matrix) {
    const [a1,a2,a3] = matrix;
    const a = length(a1), b = length(a2), c = length(a3);
    const alpha = Math.acos(dot(a2,a3)/(b*c)) * 180/Math.PI;
    const beta  = Math.acos(dot(a1,a3)/(a*c)) * 180/Math.PI;
    const gamma = Math.acos(dot(a1,a2)/(a*b)) * 180/Math.PI;
    const volume = Math.abs(dot(a1, cross(a2,a3)));
    return {a,b,c,alpha,beta,gamma,volume};
  }
  function percentDiff(v1,v2){ return Math.abs(v2-v1)/v1; }

  // --------------------------
  // Compute differences
  // --------------------------
  const p1 = latticeParameters(L1_matrix);
  const p2 = latticeParameters(L2_matrix);
  const keys = ["a","b","c","alpha","beta","gamma","volume"];
  const diffs = keys.map(k => percentDiff(p1[k],p2[k])); // 0..1 fractions
  const axisLabels = ["a","b","c","α","β","γ","V"];

  // Determine automatic scaling
  const maxDiff = Math.max(...diffs) * 1.2 || 0.1; // avoid zero

  // --------------------------
  // Create popup panel
  // --------------------------
  let existing = document.getElementById("latticeComparisonPopup");
  if (existing) {
    existing.style.display = "block"; // just show it
    return existing;
  }
  const popup = document.createElement("div");
  popup.id = "latticeComparisonPopup";
  popup.style.position = "absolute";
  popup.style.top = "120px";
  popup.style.left = "120px";
  popup.style.width = "500px";
  popup.style.height = "460px";
  popup.style.background = "rgba(26,26,26,0.9)";
  popup.style.border = "1px solid #444";
  popup.style.borderRadius = "12px";
  popup.style.boxShadow = "0 4px 12px rgba(0,0,0,0.5)";
  popup.style.zIndex = 999;
  popup.style.display = "none";
  popup.style.userSelect = "none";

  // Header bar
  const header = document.createElement("div");
  header.style.height = "30px";
  header.style.borderBottom = "1px solid #444";
  header.style.cursor = "move";
  header.style.display = "flex";
  header.style.justifyContent = "space-between";
  header.style.alignItems = "center";
  header.style.padding = "0 30px";
  popup.appendChild(header);

  const title = document.createElement("span");
  title.textContent = "Lattice Comparison";
  title.style.color = "#fff";
  header.appendChild(title);

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✖";
  closeBtn.style.cursor = "pointer";
  closeBtn.style.border = "none";
  closeBtn.style.background = "transparent";
  closeBtn.style.fontSize = "16px";
  closeBtn.style.color = "#fff";
  closeBtn.addEventListener("click", () => { 

    popup.style.display="none";
    const checkbox = document.getElementById("showComparisonInfo");
    if (checkbox) checkbox.checked = false; 
     
  });
  header.appendChild(closeBtn);

  // Canvas
  const canvas = document.createElement("canvas");
  canvas.width = 400;
  canvas.height = 400;
  canvas.style.display = "block";
  canvas.style.margin = "10px auto 0 auto";
  popup.appendChild(canvas);
  document.body.appendChild(popup);
  const ctx = canvas.getContext("2d");

  const center = {x: canvas.width/2, y: canvas.height/2 + 10};
  const radius = Math.min(canvas.width, canvas.height)/2 - 60;
  const numAxes = diffs.length;
  const gridLevels = 5;

  // --------------------------
  // Draw grid with ticks
  // --------------------------
  ctx.strokeStyle = "#666";
  ctx.fillStyle = "#fff";
  ctx.lineWidth = 1;
  ctx.font = "18px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let level = 1; level <= gridLevels; level++) {
    const r = (radius*level)/gridLevels;
    const tickValue = (level/gridLevels)*maxDiff*100; // percent
    ctx.beginPath();
    for (let i=0;i<numAxes;i++){
      const angle = (i/numAxes)*2*Math.PI - Math.PI/2;
      const x = center.x + Math.cos(angle)*r;
      const y = center.y + Math.sin(angle)*r;
      if(i===0) ctx.moveTo(x,y);
      else ctx.lineTo(x,y);
    }
    ctx.closePath();
    ctx.stroke();

    // tick labels on first axis
    const angle = -Math.PI/2;
    ctx.fillStyle="#aaa";
    ctx.fillText(tickValue.toFixed(1)+"%", center.x + Math.cos(angle)*r, center.y + Math.sin(angle)*r);
  }

  // Draw axes + axis labels
  ctx.strokeStyle = "#fff";
  for(let i=0;i<numAxes;i++){
    const angle = (i/numAxes)*2*Math.PI - Math.PI/2;
    const x = center.x + Math.cos(angle)*radius;
    const y = center.y + Math.sin(angle)*radius;
    ctx.beginPath();
    ctx.moveTo(center.x, center.y);
    ctx.lineTo(x,y);
    ctx.stroke();

    const labelX = center.x + Math.cos(angle)*(radius+25);
    const labelY = center.y + Math.sin(angle)*(radius+25);
    ctx.fillStyle = "#fff";
    ctx.fillText(axisLabels[i], labelX, labelY);
  }

  // Draw polygon
  const color = "rgba(9,140,50,0.9)";
  ctx.beginPath();
  diffs.forEach((val,i)=>{
    const angle = (i/numAxes)*2*Math.PI - Math.PI/2;
    const r = (val/maxDiff)*radius;
    const x = center.x + Math.cos(angle)*r;
    const y = center.y + Math.sin(angle)*r;
    if(i===0) ctx.moveTo(x,y);
    else ctx.lineTo(x,y);
  });
  ctx.closePath();
  ctx.fillStyle = "rgba(9,140,50, 0.3)";
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  // --------------------------
  // Collapsible matrix & differences panel
  // --------------------------
  const collapsible = document.createElement("div");
  collapsible.style.width = "100%";
  collapsible.style.margin = "10px auto";
  collapsible.style.background = "#222";
  collapsible.style.border = "1px solid #444";
  collapsible.style.borderRadius = "6px";
  collapsible.style.color = "#fff";
  popup.appendChild(collapsible);

  const toggleBtn = document.createElement("button");
  toggleBtn.textContent = "Show details ▼";
  toggleBtn.style.width = "100%";
  toggleBtn.style.background = "#333";
  toggleBtn.style.border = "none";
  toggleBtn.style.color = "#fff";
  toggleBtn.style.cursor = "pointer";
  toggleBtn.style.padding = "5px";
  toggleBtn.addEventListener("click", ()=>{
    if(content.style.display==="none"){
      content.style.display="block";
      toggleBtn.textContent="Hide details ▲";
    } else {
      content.style.display="none";
      toggleBtn.textContent="Show details ▼";
    }
  });
  collapsible.appendChild(toggleBtn);

  const content = document.createElement("div");
  content.style.display="none";
  content.style.padding="5px";
  collapsible.appendChild(content);

  // Table
  const table = document.createElement("table");
  table.style.width="100%";
  table.style.borderCollapse="collapse";
  content.appendChild(table);

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Parameter","Main","Struc2","% Diff"].forEach(t=>{
    const th = document.createElement("th");
    th.textContent = t;
    th.style.borderBottom="1px solid #555";
    th.style.padding="2px 5px";
    th.style.color="#fff";
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const label = ["a","b","c","α","β","γ","V"];
  keys.forEach((k,i)=>{
    const row = document.createElement("tr");
    const parameter = label[i]
    const v1 = p1[k].toFixed(4);
    const v2 = p2[k].toFixed(4);
    const diffPercent = (diffs[i]*100).toFixed(2)+"%";

    [parameter,v1,v2,diffPercent].forEach(val=>{
      const td = document.createElement("td");
      td.textContent = val;
      td.style.padding="2px 5px";
      td.style.borderBottom="1px solid #444";
      row.appendChild(td);
    });
    tbody.appendChild(row);
  });
  table.appendChild(tbody);

  // --------------------------
  // Dragging only from header
  // --------------------------
  let offsetX, offsetY, dragging=false;
  header.addEventListener("mousedown", e=>{
    dragging=true;
    offsetX = e.clientX - popup.offsetLeft;
    offsetY = e.clientY - popup.offsetTop;
    header.style.cursor = "grabbing";
  });
  document.addEventListener("mouseup", ()=>{
    dragging=false;
    header.style.cursor="move";
  });
  document.addEventListener("mousemove", e=>{
    if(!dragging) return;
    popup.style.left = e.clientX - offsetX + "px";
    popup.style.top = e.clientY - offsetY + "px";
  });

  return popup;
}

