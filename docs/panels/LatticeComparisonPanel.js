// Helper functions for lattice calculations
function length(v) { return Math.sqrt(v[0]**2 + v[1]**2 + v[2]**2); }
function dot(u, v) { return u[0]*v[0] + u[1]*v[1] + u[2]*v[2]; }
function cross(u, v) {
  return [
    u[1]*v[2] - u[2]*v[1],
    u[2]*v[0] - u[0]*v[2],
    u[0]*v[1] - u[1]*v[0]
  ];
}

function latticeParameters(matrix) {
  const [a1, a2, a3] = matrix;
  const a = length(a1), b = length(a2), c = length(a3);
  const alpha = Math.acos(dot(a2, a3) / (b * c)) * 180 / Math.PI;
  const beta = Math.acos(dot(a1, a3) / (a * c)) * 180 / Math.PI;
  const gamma = Math.acos(dot(a1, a2) / (a * b)) * 180 / Math.PI;
  const volume = Math.abs(dot(a1, cross(a2, a3)));
  return { a, b, c, alpha, beta, gamma, volume };
}

function percentDiff(v1, v2) { return Math.abs(v2 - v1) / v1; }

// Function to render the content of the lattice comparison panel
function renderLatticeComparisonContent(L1_matrix, L2_matrix, canvas, table, content, toggleBtn) {
  // Compute parameters and differences
  const p1 = latticeParameters(L1_matrix);
  const p2 = latticeParameters(L2_matrix);
  const keys = ["a", "b", "c", "alpha", "beta", "gamma", "volume"];
  const diffs = keys.map(k => percentDiff(p1[k], p2[k]));
  const maxDiff = Math.max(...diffs) * 1.2 || 0.1;
  const axisLabels = ["a", "b", "c", "α", "β", "γ", "V"];

  // --- Update Table ---
  let tbody = table.querySelector("tbody");
  if (!tbody) {
    tbody = document.createElement("tbody");
    table.appendChild(tbody);
  }
  while (tbody.rows.length > 0) {
    tbody.deleteRow(0);
  }

  // Add new rows to tbody
  keys.forEach((k, i) => {
    const row = tbody.insertRow();
    const parameter = axisLabels[i];
    const v1 = p1[k].toFixed(2);
    const v2 = p2[k].toFixed(2);
    const diffPercent = (diffs[i] * 100).toFixed(2) + "%";

    [parameter, v1, v2, diffPercent].forEach(val => {
      const cell = row.insertCell();
      cell.textContent = val;
      cell.style.padding = "2px 5px";
      cell.style.borderBottom = "1px solid #444";
    });
  });

  // --- Update Canvas (Radar Plot) ---
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    console.error("Canvas context not found!");
    return;
  }

  // Set canvas dimensions explicitly
  const dpi = window.devicePixelRatio || 1;
  const displayWidth = 400;
  const displayHeight = 400;
  canvas.width = displayWidth * dpi;
  canvas.height = displayHeight * dpi;
  canvas.style.width = `${displayWidth}px`;
  canvas.style.height = `${displayHeight}px`;

  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Center and radius
  const center = { x: canvas.width / 2, y: canvas.height / 2 };
  const radius = Math.min(canvas.width, canvas.height) / 2 - 60;

  // Draw grid
  ctx.strokeStyle = "#666";
  ctx.fillStyle = "#fff";
  ctx.lineWidth = 1;
  ctx.font = `${12 * dpi}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let level = 1; level <= 5; level++) {
    const r = (radius * level) / 5;
    const tickValue = (level / 5) * maxDiff * 100;
    ctx.beginPath();
    for (let i = 0; i < keys.length; i++) {
      const angle = (i / keys.length) * 2 * Math.PI - Math.PI / 2;
      const x = center.x + Math.cos(angle) * r;
      const y = center.y + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = "#aaa";
    ctx.fillText(
      tickValue.toFixed(1) + "%",
      center.x + Math.cos(-Math.PI / 2) * r,
      center.y + Math.sin(-Math.PI / 2) * r
    );
  }

  // Draw axes
  ctx.strokeStyle = "#fff";
  for (let i = 0; i < keys.length; i++) {
    const angle = (i / keys.length) * 2 * Math.PI - Math.PI / 2;
    const x = center.x + Math.cos(angle) * radius;
    const y = center.y + Math.sin(angle) * radius;
    ctx.beginPath();
    ctx.moveTo(center.x, center.y);
    ctx.lineTo(x, y);
    ctx.stroke();
    const labelX = center.x + Math.cos(angle) * (radius + 25);
    const labelY = center.y + Math.sin(angle) * (radius + 25);
    ctx.fillStyle = "#fff";
    ctx.fillText(axisLabels[i], labelX, labelY);
  }

  // Draw polygon
  ctx.beginPath();
  diffs.forEach((val, i) => {
    const angle = (i / keys.length) * 2 * Math.PI - Math.PI / 2;
    const r = (val / maxDiff) * radius;
    const x = center.x + Math.cos(angle) * r;
    const y = center.y + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = "rgba(9, 140, 50, 0.4)";
  ctx.fill();
  ctx.strokeStyle = "rgba(9, 140, 50, 0.9)";
  ctx.lineWidth = 4;
  ctx.stroke();
}


export function createLatticeComparisonPopup() {
  // Remove existing popup (if any)
  let existing = document.getElementById("latticeComparisonPopup");
  if (existing) {
    existing.remove();
  }

  // Create popup
  const popup = document.createElement("div");
  popup.id = "latticeComparisonPopup";
  popup.className = "popup";
  popup.style.display = "block";
  popup.style.position = "fixed";
  popup.style.top = "50%";
  popup.style.left = "50%";
  popup.style.transform = "translate(-50%, -50%)";
  popup.style.zIndex = "9999";
  popup.style.backgroundColor = "#222";
  popup.style.color = "#fff";
  popup.style.opacity = "1";
  popup.style.pointerEvents = "auto";
  popup.style.border = "1px solid #555";
  popup.style.padding = "10px";
  popup.style.maxHeight = "80vh";
  popup.style.overflowY = "auto";

  // Append to body
  document.body.appendChild(popup);

  // --- Create header ---
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
    removeLatticeComparisonPopup();
  });
  header.appendChild(closeBtn);

  // --- Create canvas ---
  const canvas = document.createElement("canvas");
  const dpi = window.devicePixelRatio || 1;
  const displayWidth = 400;
  const displayHeight = 400;
  canvas.width = displayWidth * dpi;
  canvas.height = displayHeight * dpi;
  canvas.style.width = `${displayWidth}px`;
  canvas.style.height = `${displayHeight}px`;
  canvas.style.display = "block";
  canvas.style.margin = "10px auto 0 auto";
  popup.appendChild(canvas);

  // --- Create collapsible details ---
  const collapsible = document.createElement("div");
  collapsible.style.width = "100%";
  collapsible.style.margin = "10px auto";
  collapsible.style.background = "#222";
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
  collapsible.appendChild(toggleBtn);

  const content = document.createElement("div");
  content.style.display = "none";
  content.style.padding = "5px";
  collapsible.appendChild(content);

  // --- Create table ---
  const table = document.createElement("table");
  table.style.width = "100%";
  table.style.fontSize = "12px";
  table.style.borderCollapse = "collapse";
  content.appendChild(table);

  // --- Add table header ---
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Parameter", "Main", "Struc2", "% Diff"].forEach(t => {
    const th = document.createElement("th");
    th.textContent = t;
    th.style.borderBottom = "1px solid #555";
    th.style.padding = "2px 5px";
    th.style.color = "#fff";
    th.style.textAlign = "left";
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  // --- Add tbody ---
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);

  // --- Toggle button logic ---
  toggleBtn.addEventListener("click", () => {
    if (content.style.display === "none") {
      content.style.display = "block";
      toggleBtn.textContent = "Hide details ▲";
    } else {
      content.style.display = "none";
      toggleBtn.textContent = "Show details ▼";
    }

    // Update popup position to ensure it stays in view
    const popupRect = popup.getBoundingClientRect();
    const halfWidth = popupRect.width / 2;
    const halfHeight = popupRect.height / 2;

    // Current center position
    let newCenterX = parseInt(popup.style.left) || window.innerWidth / 2;
    let newCenterY = parseInt(popup.style.top) || window.innerHeight / 2;

    // Compute viewport bounds for the popup's center
    const maxCenterX = window.innerWidth - halfWidth;
    const maxCenterY = window.innerHeight - halfHeight;

    // Clamp the center position so the entire popup stays in view
    newCenterX = Math.max(halfWidth, Math.min(newCenterX, maxCenterX));
    newCenterY = Math.max(halfHeight, Math.min(newCenterY, maxCenterY));

    // Set the popup's position (center-based)
    popup.style.left = `${newCenterX}px`;
    popup.style.top = `${newCenterY}px`;
  });

  // --- Dragging logic ---
  let offsetX, offsetY, dragging = false;
  header.addEventListener("mousedown", (e) => {
    dragging = true;
    // Use the popup's center for offset calculation
    const popupRect = popup.getBoundingClientRect();
    offsetX = e.clientX - (popupRect.left + popupRect.width / 2);
    offsetY = e.clientY - (popupRect.top + popupRect.height / 2);
    header.style.cursor = "grabbing";
  });

  document.addEventListener("mouseup", () => {
    dragging = false;
    header.style.cursor = "move";
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;

    // Calculate new center position
    let newCenterX = e.clientX - offsetX;
    let newCenterY = e.clientY - offsetY;

    // Get the popup's dimensions
    const popupRect = popup.getBoundingClientRect();
    const halfWidth = popupRect.width / 2;
    const halfHeight = popupRect.height / 2;

    // Compute viewport bounds for the popup's center
    const maxCenterX = window.innerWidth - halfWidth;
    const maxCenterY = window.innerHeight - halfHeight;

    // Clamp the center position so the entire popup stays in view
    newCenterX = Math.max(halfWidth, Math.min(newCenterX, maxCenterX));
    newCenterY = Math.max(halfHeight, Math.min(newCenterY, maxCenterY));

    // Set the popup's position (center-based)
    popup.style.left = `${newCenterX}px`;
    popup.style.top = `${newCenterY}px`;
  });

  return { popup, canvas, table, content, toggleBtn };
}




// Function to update the lattice comparison panel
export function updateLatticeComparisonPanel(L1_matrix, L2_matrix) {
  let popup = document.getElementById("latticeComparisonPopup");

  // If the popup doesn't exist, create it
  if (!popup) {
    const { popup: newPopup, canvas, table, content, toggleBtn } = createLatticeComparisonPopup();
    renderLatticeComparisonContent(L1_matrix, L2_matrix, canvas, table, content, toggleBtn);
    return;
  }

  // Find canvas and table elements
  const canvas = popup.querySelector("canvas");
  const collapsible = popup.querySelector("div:last-child");
  const content = collapsible.querySelector("div:last-child");
  const table = content.querySelector("table");
  const toggleBtn = collapsible.querySelector("button");

  if (!canvas || !table || !toggleBtn) {
    console.error("Popup elements not found!");
    return;
  }

  // Update content
  renderLatticeComparisonContent(L1_matrix, L2_matrix, canvas, table, content, toggleBtn);
}

/**
 * Removes the lattice comparison popup from the DOM.
 *  */
  export function removeLatticeComparisonPopup() {
      const popup = document.getElementById("latticeComparisonPopup");
      if (popup) {
            popup.remove();
          }
  }

