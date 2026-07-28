/**
 * Graph panel chrome: collapse, drag, remove, canvas host.
 */
import { titleForPanel } from "./catalog.js";

/**
 * @param {HTMLElement} mount
 * @param {object} panel
 * @param {object} handlers { onRemove, onToggle, onReorderDrag }
 */
export function createPanelElement(panel, handlers) {
  handlers = handlers || {};
  const el = document.createElement("section");
  el.className = "graph-panel card";
  el.dataset.panelId = panel.id;
  el.draggable = false;

  el.innerHTML =
    '<div class="graph-panel-head">' +
    '  <button type="button" class="graph-drag ghost" title="Drag to reorder" aria-label="Reorder">⠿</button>' +
    '  <button type="button" class="graph-collapse ghost" title="Collapse" aria-expanded="true">▾</button>' +
    '  <div class="graph-panel-titles">' +
    '    <h2 class="graph-panel-title"></h2>' +
    '    <p class="graph-panel-sub hint"></p>' +
    "  </div>" +
    '  <span class="graph-panel-meta hint"></span>' +
    '  <button type="button" class="graph-remove ghost" title="Remove graph" aria-label="Remove">×</button>' +
    "</div>" +
    '<div class="graph-panel-body">' +
    '  <div class="graph-canvas-wrap">' +
    '    <canvas class="graph-canvas" width="900" height="220" aria-label="Time series"></canvas>' +
    "  </div>" +
    '  <div class="graph-legend"></div>' +
    "</div>";

  const titleEl = el.querySelector(".graph-panel-title");
  const subEl = el.querySelector(".graph-panel-sub");
  const metaEl = el.querySelector(".graph-panel-meta");
  const body = el.querySelector(".graph-panel-body");
  const collapseBtn = el.querySelector(".graph-collapse");
  const removeBtn = el.querySelector(".graph-remove");
  const dragBtn = el.querySelector(".graph-drag");
  const canvas = el.querySelector(".graph-canvas");
  const legend = el.querySelector(".graph-legend");

  function syncChrome() {
    titleEl.textContent = titleForPanel(panel);
    const s = panel.source || {};
    const bits = [];
    if (s.kind && s.kind !== "cpe") bits.push(s.kind);
    if (s.band) bits.push(s.band + " GHz");
    if (s.ifname) bits.push(s.ifname);
    subEl.textContent = bits.join(" · ") || "Scroll wheel zoom · drag pan · double-click live";
    el.classList.toggle("is-collapsed", !!panel.collapsed);
    collapseBtn.setAttribute("aria-expanded", panel.collapsed ? "false" : "true");
    collapseBtn.textContent = panel.collapsed ? "▸" : "▾";
    body.hidden = !!panel.collapsed;
    canvas.setAttribute("data-h", String(panel.height || 220));
    canvas.style.height = (panel.height || 220) + "px";
  }

  syncChrome();

  collapseBtn.addEventListener("click", function () {
    panel.collapsed = !panel.collapsed;
    syncChrome();
    if (handlers.onToggle) handlers.onToggle(panel);
  });

  removeBtn.addEventListener("click", function () {
    if (handlers.onRemove) handlers.onRemove(panel);
  });

  /* HTML5 drag via handle only */
  dragBtn.addEventListener("pointerdown", function () {
    el.draggable = true;
  });
  el.addEventListener("dragstart", function (ev) {
    ev.dataTransfer.setData("text/panel-id", panel.id);
    ev.dataTransfer.effectAllowed = "move";
    el.classList.add("is-dragging");
    if (handlers.onDragStart) handlers.onDragStart(panel);
  });
  el.addEventListener("dragend", function () {
    el.draggable = false;
    el.classList.remove("is-dragging");
  });
  el.addEventListener("dragover", function (ev) {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    el.classList.add("is-drop-target");
  });
  el.addEventListener("dragleave", function () {
    el.classList.remove("is-drop-target");
  });
  el.addEventListener("drop", function (ev) {
    ev.preventDefault();
    el.classList.remove("is-drop-target");
    const fromId = ev.dataTransfer.getData("text/panel-id");
    if (fromId && fromId !== panel.id && handlers.onDrop) {
      handlers.onDrop(fromId, panel.id);
    }
  });

  return {
    el: el,
    canvas: canvas,
    legend: legend,
    metaEl: metaEl,
    panel: panel,
    syncChrome: syncChrome,
    setMeta: function (text) {
      metaEl.textContent = text || "";
    },
    setLegend: function (items) {
      if (!items || !items.length) {
        legend.innerHTML = "";
        return;
      }
      legend.innerHTML = items
        .map(function (it) {
          return (
            '<span class="graph-leg"><i style="background:' +
            (it.color || "#6b8cff") +
            '"></i>' +
            escapeHtml(it.label || "") +
            "</span>"
          );
        })
        .join("");
    },
    destroy: function () {
      if (el.parentElement) el.parentElement.removeChild(el);
    }
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
