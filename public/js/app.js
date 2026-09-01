// CELLVENTAS - Asistente de Compatibilidades, Matriz Multimodelo & POS Especializado
// by VT VALETEC

let BRANDS = [];
let PRODUCTS = [];
let CLIENTS = [];
let SALES = [];
let COVERAGE = [];
let CART = [];
let selectedPaymentMethod = 'Efectivo';
let pendingImeiProduct = null;
let currentCoverageFilter = 'all';

// Conexión WebSockets
const socket = typeof io !== 'undefined' ? io() : null;
if (socket) {
  socket.on('sale_completed', () => { loadDashboard(); loadSalesHistory(); loadCashStatus(); });
  socket.on('sale_annulled', () => { loadProducts(); loadDashboard(); loadSalesHistory(); loadCashStatus(); });
  socket.on('product_updated', () => { loadProducts(); loadBrandsAndModels(); });
  socket.on('compatibility_updated', () => { loadBrandsAndModels(); loadCoverageData(); });
  socket.on('cash_updated', () => { loadCashStatus(); });
}

// Inicialización
async function init() {
  await loadBrandsAndModels();
  await loadProducts();
  await loadCustomers();
  await loadDashboard();
  await loadCoverageData();
  await loadCashStatus();
  await loadSalesHistory();
}

function switchTab(tabId) {
  document.querySelectorAll('.view-section').forEach(el => el.classList.add('hidden'));
  const target = document.getElementById('view-' + tabId);
  if (target) target.classList.remove('hidden');

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.className = 'nav-btn w-full flex items-center gap-3 px-3.5 py-3 rounded-xl text-gray-400 hover:bg-gray-800 hover:text-white font-bold transition-all';
  });
  const activeBtn = document.getElementById('btn-tab-' + tabId);
  if (activeBtn) {
    activeBtn.className = 'nav-btn w-full flex items-center gap-3 px-3.5 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-700 text-white font-black transition-all shadow-md';
  }

  if (tabId === 'assistant') populateAssistantBrandDropdown();
  if (tabId === 'pos') { populateBrandFilters(); renderProducts(); }
  if (tabId === 'compatibility') { loadCoverageData(); renderCompatibilityMatrix(); }
  if (tabId === 'inventory') renderInventoryTable();
  if (tabId === 'imeis') searchImeiTracker();
  if (tabId === 'sales-history') loadSalesHistory();
  if (tabId === 'cash') loadCashStatus();
  if (tabId === 'fiados') renderFiadosTable();
  if (tabId === 'dashboard') loadDashboard();
}

// ==============================================================
// 1. CARGADORES DE DATOS BASE (API)
// ==============================================================
async function loadBrandsAndModels() {
  try {
    const res = await fetch('/api/brands');
    BRANDS = await res.json();
    populateAssistantBrandDropdown();
    populateBrandFilters();
    populateModelCheckboxes();
    renderCompatibilityMatrix();
  } catch (err) {
    console.error('Error cargando marcas:', err);
  }
}

async function loadProducts() {
  try {
    const res = await fetch('/api/products');
    PRODUCTS = await res.json();
    renderProducts();
    renderInventoryTable();
  } catch (err) {
    console.error('Error cargando productos:', err);
  }
}

async function loadCustomers() {
  try {
    const res = await fetch('/api/customers');
    CLIENTS = await res.json();
    populateCustomerDropdown();
    renderFiadosTable();
  } catch (err) {
    console.error('Error cargando clientes:', err);
  }
}

async function loadDashboard() {
  try {
    const res = await fetch('/api/dashboard');
    const data = await res.json();
    document.getElementById('dash-sales').innerText = `S/ ${(data.todaySales || 0).toFixed(2)}`;
    document.getElementById('dash-tickets').innerText = `${data.todayTickets || 0}`;
    document.getElementById('dash-total-fiado').innerText = `S/ ${(data.totalFiadosDebt || 0).toFixed(2)}`;
    document.getElementById('dash-top-product').innerText = data.topProduct || '--';
  } catch (err) {}
}

// ==============================================================
// 2. ASISTENTE DE MOSTRADOR: FICHA 360° DE COMPATIBILIDAD
// ==============================================================
function populateAssistantBrandDropdown() {
  const brandSelect = document.getElementById('assistant-brand-select');
  if (!brandSelect) return;
  brandSelect.innerHTML = '<option value="">-- Seleccionar Marca --</option>' + 
    BRANDS.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
}

function onAssistantBrandChange() {
  const brandId = document.getElementById('assistant-brand-select').value;
  const modelSelect = document.getElementById('assistant-model-select');
  
  if (!brandId) {
    modelSelect.innerHTML = '<option value="">-- Primero elija una marca --</option>';
    return;
  }

  const brand = BRANDS.find(b => String(b.id) === String(brandId));
  const models = brand ? brand.models : [];
  modelSelect.innerHTML = '<option value="">-- Seleccionar Modelo de ' + brand.name + ' --</option>' + 
    models.map(m => `<option value="${m.id}">${m.model_name} (${m.release_year || 2024})</option>`).join('');
}

async function loadAssistantModelData(customModelId = null) {
  const modelId = customModelId || document.getElementById('assistant-model-select').value;
  const container = document.getElementById('assistant-results-container');
  if (!modelId) return;

  container.innerHTML = `<div class="text-center py-12 text-gray-500 font-bold text-sm"><i class="fa-solid fa-spinner fa-spin mr-2"></i> Consultando ficha de compatibilidades...</div>`;

  try {
    const res = await fetch(`/api/compatibilities/assistant/${modelId}`);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Error al consultar compatibilidad');

    const { model, products } = data;

    // Agrupar por categorías clave
    const cases = products.filter(p => (p.category || '').toLowerCase().includes('case') || (p.category || '').toLowerCase().includes('funda'));
    const micas = products.filter(p => (p.category || '').toLowerCase().includes('mica') || (p.category || '').toLowerCase().includes('protector'));
    const cargadores = products.filter(p => (p.category || '').toLowerCase().includes('cargador') || (p.category || '').toLowerCase().includes('cable'));
    const otros = products.filter(p => !cases.includes(p) && !micas.includes(p) && !cargadores.includes(p));

    const renderCard = (p) => {
      const isLow = p.stock <= 0;
      const sharedBadges = (p.shared_with && p.shared_with.length > 0) ? `
        <div class="mt-2 p-2 bg-indigo-50 rounded-xl border border-indigo-100">
          <p class="text-[10px] font-black text-indigo-900 leading-tight">
            <i class="fa-solid fa-share-nodes text-indigo-600 mr-1"></i> También le hace a:
          </p>
          <p class="text-[10px] font-medium text-indigo-700 mt-0.5 line-clamp-2">${p.shared_with.join(', ')}</p>
        </div>
      ` : '';

      return `
        <div class="bg-white p-4 rounded-2xl border border-gray-200 shadow-sm hover:shadow-md transition-all flex flex-col justify-between">
          <div>
            <div class="flex justify-between items-start mb-1.5">
              <span class="bg-gray-100 text-gray-700 text-[10px] font-bold px-2 py-0.5 rounded-md">${p.category}</span>
              <span class="text-[10px] font-mono text-gray-400">#${p.code}</span>
            </div>
            <h4 class="font-bold text-xs text-gray-900 line-clamp-2">${p.name}</h4>
            ${sharedBadges}
          </div>
          <div class="mt-4 pt-3 border-t border-gray-100 flex justify-between items-center">
            <div>
              <span class="text-[10px] font-bold ${isLow ? 'text-red-600' : 'text-green-700'}">
                Stock: ${p.stock} und.
              </span>
              <p class="text-base font-black text-indigo-600">S/ ${p.price.toFixed(2)}</p>
            </div>
            <button onclick="addToCartFromAssistant(${p.id})" ${isLow ? 'disabled' : ''} class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-200 text-white rounded-xl text-xs font-bold shadow-sm flex items-center gap-1.5">
              <i class="fa-solid fa-cart-plus"></i> Vender
            </button>
          </div>
        </div>
      `;
    };

    container.innerHTML = `
      <!-- BANNER DE RESUMEN DEL MODELO -->
      <div class="bg-white p-6 rounded-3xl border border-indigo-100 shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <span class="text-xs font-black uppercase tracking-wider text-indigo-600">${model.brand_name}</span>
          <h3 class="text-2xl font-black text-gray-900 mt-0.5 flex items-center gap-2">
            <i class="fa-solid fa-mobile text-indigo-600"></i> ${model.model_name}
          </h3>
          <p class="text-xs text-gray-400">Año de lanzamiento: ${model.release_year || 2024}</p>
        </div>
        <div class="flex gap-3">
          <div class="px-4 py-2 bg-indigo-50 text-indigo-900 rounded-2xl border border-indigo-100 text-center">
            <p class="text-[10px] uppercase font-bold text-gray-500">Fundas / Cases</p>
            <p class="text-lg font-black text-indigo-700">${cases.length} opciones</p>
          </div>
          <div class="px-4 py-2 bg-green-50 text-green-900 rounded-2xl border border-green-100 text-center">
            <p class="text-[10px] uppercase font-bold text-gray-500">Micas / Protectores</p>
            <p class="text-lg font-black text-green-700">${micas.length} opciones</p>
          </div>
        </div>
      </div>

      <!-- SECCIÓN 1: FUNDAS Y CASES -->
      <div class="space-y-3">
        <div class="flex items-center gap-2">
          <div class="w-7 h-7 rounded-lg bg-indigo-600 text-white flex items-center justify-center text-xs"><i class="fa-solid fa-shield-cat"></i></div>
          <h3 class="text-base font-black text-gray-800">1. Fundas, Cases y Protectores Antigolpe (${cases.length})</h3>
        </div>
        ${cases.length === 0 ? `
          <div class="p-6 bg-red-50 border border-red-100 text-red-800 rounded-2xl text-xs font-bold flex items-center gap-2">
            <i class="fa-solid fa-triangle-exclamation text-red-600 text-base"></i> No hay fundas ni cases registrados o en stock para este modelo.
          </div>
        ` : `<div class="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">${cases.map(renderCard).join('')}</div>`}
      </div>

      <!-- SECCIÓN 2: MICAS Y VIDRIOS TEMPLADOS -->
      <div class="space-y-3">
        <div class="flex items-center gap-2">
          <div class="w-7 h-7 rounded-lg bg-green-600 text-white flex items-center justify-center text-xs"><i class="fa-solid fa-square"></i></div>
          <h3 class="text-base font-black text-gray-800">2. Micas de Vidrio, Cerámica, Hidrogel & Cámara (${micas.length})</h3>
        </div>
        ${micas.length === 0 ? `
          <div class="p-6 bg-red-50 border border-red-100 text-red-800 rounded-2xl text-xs font-bold flex items-center gap-2">
            <i class="fa-solid fa-triangle-exclamation text-red-600 text-base"></i> Alerta: 0 micas registradas para este modelo.
          </div>
        ` : `<div class="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">${micas.map(renderCard).join('')}</div>`}
      </div>

      <!-- SECCIÓN 3: OTROS COMPATIBLES / REPUESTOS -->
      ${(cargadores.length > 0 || otros.length > 0) ? `
        <div class="space-y-3">
          <div class="flex items-center gap-2">
            <div class="w-7 h-7 rounded-lg bg-yellow-600 text-white flex items-center justify-center text-xs"><i class="fa-solid fa-bolt"></i></div>
            <h3 class="text-base font-black text-gray-800">3. Cargadores, Cables y Repuestos Compatibles (${cargadores.length + otros.length})</h3>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
            ${[...cargadores, ...otros].map(renderCard).join('')}
          </div>
        </div>
      ` : ''}
    `;

  } catch (err) {
    container.innerHTML = `<div class="p-6 bg-red-50 border border-red-100 text-red-800 rounded-2xl text-xs font-bold">Error: ${err.message}</div>`;
  }
}

function addToCartFromAssistant(productId) {
  addToCart(productId);
  switchTab('pos');
}

// ==============================================================
// 3. MATRIZ & AUDITORÍA DE COMPATIBILIDAD
// ==============================================================
function switchCompatSubtab(subtab) {
  if (subtab === 'coverage') {
    document.getElementById('subtab-coverage').classList.remove('hidden');
    document.getElementById('subtab-catalog').classList.add('hidden');
    document.getElementById('subtab-btn-coverage').className = 'font-bold text-xs pb-3 border-b-2 border-indigo-600 text-indigo-600';
    document.getElementById('subtab-btn-catalog').className = 'font-bold text-xs pb-3 border-b-2 border-transparent text-gray-400 hover:text-gray-700';
    loadCoverageData();
  } else {
    document.getElementById('subtab-coverage').classList.add('hidden');
    document.getElementById('subtab-catalog').classList.remove('hidden');
    document.getElementById('subtab-btn-coverage').className = 'font-bold text-xs pb-3 border-b-2 border-transparent text-gray-400 hover:text-gray-700';
    document.getElementById('subtab-btn-catalog').className = 'font-bold text-xs pb-3 border-b-2 border-indigo-600 text-indigo-600';
    renderCompatibilityMatrix();
  }
}

async function loadCoverageData() {
  try {
    const res = await fetch('/api/compatibilities/coverage');
    COVERAGE = await res.json();
    renderCoverageGrid();
  } catch (err) {
    console.error('Error cargando cobertura:', err);
  }
}

function filterCoverage(mode) {
  currentCoverageFilter = mode;
  ['all', 'needsMicas', 'needsCases'].forEach(m => {
    const btn = document.getElementById('cov-filter-' + m);
    if (btn) {
      btn.className = (m === mode) 
        ? 'px-3 py-1 bg-indigo-600 text-white rounded-lg text-xs font-bold' 
        : 'px-3 py-1 bg-gray-100 text-gray-700 rounded-lg text-xs font-bold hover:bg-gray-200';
    }
  });
  renderCoverageGrid();
}

function renderCoverageGrid() {
  const container = document.getElementById('coverage-grid');
  if (!container) return;

  const filtered = COVERAGE.filter(m => {
    if (currentCoverageFilter === 'needsMicas') return m.needsMicas;
    if (currentCoverageFilter === 'needsCases') return m.needsCases;
    return true;
  });

  document.getElementById('cov-count-label').innerText = `${filtered.length} modelos mostrados`;

  if (filtered.length === 0) {
    container.innerHTML = `<div class="col-span-full text-center py-12 text-gray-400 font-bold text-xs">No hay modelos que coincidan con el filtro.</div>`;
    return;
  }

  container.innerHTML = filtered.map(m => `
    <div class="bg-white p-5 rounded-3xl border ${m.needsMicas || m.needsCases ? 'border-yellow-200 bg-yellow-50/20' : 'border-gray-200'} shadow-sm space-y-3">
      <div class="flex justify-between items-start">
        <div>
          <span class="text-[10px] font-black uppercase text-indigo-600">${m.brand_name}</span>
          <h4 class="font-black text-sm text-gray-900">${m.model_name}</h4>
          <p class="text-[10px] text-gray-400">Año ${m.release_year}</p>
        </div>
        <button onclick="switchTab('assistant'); document.getElementById('assistant-brand-select').value='${m.brand_id}'; onAssistantBrandChange(); document.getElementById('assistant-model-select').value='${m.id}'; loadAssistantModelData(${m.id});" class="text-indigo-600 hover:text-indigo-800 text-xs font-bold bg-indigo-50 px-2.5 py-1 rounded-xl">
          Ver 360° <i class="fa-solid fa-arrow-right ml-1"></i>
        </button>
      </div>

      <div class="grid grid-cols-2 gap-2 pt-2 border-t border-gray-100">
        <div class="p-2.5 rounded-2xl ${m.needsCases ? 'bg-red-50 text-red-800 border border-red-100' : 'bg-gray-50 text-gray-700'}">
          <p class="text-[9px] uppercase font-bold text-gray-400">Cases / Fundas</p>
          <p class="text-xs font-black ${m.needsCases ? 'text-red-600' : 'text-gray-900'}">${m.casesStock} en stock (${m.casesCount} tipos)</p>
          ${m.needsCases ? '<span class="text-[9px] font-bold text-red-600 uppercase">⚠️ Desabastecido</span>' : ''}
        </div>
        <div class="p-2.5 rounded-2xl ${m.needsMicas ? 'bg-red-50 text-red-800 border border-red-100' : 'bg-gray-50 text-gray-700'}">
          <p class="text-[9px] uppercase font-bold text-gray-400">Micas / Vidrios</p>
          <p class="text-xs font-black ${m.needsMicas ? 'text-red-600' : 'text-gray-900'}">${m.micasStock} en stock (${m.micasCount} tipos)</p>
          ${m.needsMicas ? '<span class="text-[9px] font-bold text-red-600 uppercase">⚠️ Desabastecido</span>' : ''}
        </div>
      </div>
    </div>
  `).join('');
}

function renderCompatibilityMatrix() {
  const container = document.getElementById('subtab-catalog');
  if (!container) return;

  if (BRANDS.length === 0) {
    container.innerHTML = `<div class="col-span-full text-center py-12 text-gray-400 font-bold">No hay marcas ni modelos registrados.</div>`;
    return;
  }

  container.innerHTML = BRANDS.map(b => `
    <div class="bg-white p-5 rounded-3xl border border-gray-200 shadow-sm space-y-3">
      <div class="flex justify-between items-center pb-2 border-b border-gray-100">
        <h3 class="font-black text-indigo-900 text-sm flex items-center gap-2">
          <i class="fa-solid fa-mobile text-indigo-600"></i> ${b.name}
        </h3>
        <span class="bg-indigo-50 text-indigo-700 text-xs font-bold px-2.5 py-0.5 rounded-full">${b.models.length} Modelos</span>
      </div>
      <div class="divide-y divide-gray-100 max-h-56 overflow-y-auto custom-scrollbar">
        ${b.models.map(m => `
          <div class="py-2 flex justify-between items-center text-xs">
            <span class="font-bold text-gray-800"><i class="fa-solid fa-angle-right text-indigo-400 mr-1.5"></i>${m.model_name}</span>
            <div class="flex items-center gap-2">
              <span class="text-gray-400 text-[10px]">${m.release_year || 2024}</span>
              <button onclick="deleteModel(${m.id})" class="text-red-400 hover:text-red-600 text-[10px] font-bold"><i class="fa-solid fa-trash"></i></button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

// ASIGNADOR RÁPIDO MULTIMODELO
function openBulkCompatModal() {
  const prodSelect = document.getElementById('bulk-product-select');
  prodSelect.innerHTML = '<option value="">-- Seleccione un Producto / Accesorio --</option>' + 
    PRODUCTS.map(p => `<option value="${p.id}">${p.name} (#${p.code}) - ${p.category}</option>`).join('');

  const modelsContainer = document.getElementById('bulk-models-container');
  let html = '';
  BRANDS.forEach(b => {
    if (b.models && b.models.length > 0) {
      html += `<div class="col-span-full font-black text-indigo-900 text-[10px] uppercase border-b border-indigo-100 pt-2">${b.name}</div>`;
      b.models.forEach(m => {
        html += `
          <label class="flex items-center gap-1.5 cursor-pointer bg-white p-1.5 rounded-xl border border-gray-200 hover:border-indigo-300">
            <input type="checkbox" name="bulk_compat_models" value="${m.id}" class="rounded text-indigo-600">
            <span class="truncate">${m.model_name}</span>
          </label>
        `;
      });
    }
  });
  modelsContainer.innerHTML = html;
  document.getElementById('modal-bulk-compat').classList.remove('hidden');
}

function closeBulkCompatModal() {
  document.getElementById('modal-bulk-compat').classList.add('hidden');
}

function loadProductCurrentCompats() {
  const prodId = document.getElementById('bulk-product-select').value;
  if (!prodId) return;

  const prod = PRODUCTS.find(p => String(p.id) === String(prodId));
  const currentModelIds = (prod && prod.compatible_models) ? prod.compatible_models.map(m => String(m.model_id)) : [];

  document.querySelectorAll('input[name="bulk_compat_models"]').forEach(cb => {
    cb.checked = currentModelIds.includes(cb.value);
  });
}

function toggleAllBulkCheckboxes(check) {
  document.querySelectorAll('input[name="bulk_compat_models"]').forEach(cb => cb.checked = check);
}

async function saveBulkCompatibilities() {
  const productId = document.getElementById('bulk-product-select').value;
  if (!productId) {
    alert('⚠️ Por favor seleccione un producto.');
    return;
  }

  const selectedModelIds = Array.from(document.querySelectorAll('input[name="bulk_compat_models"]:checked')).map(cb => parseInt(cb.value));

  try {
    const res = await fetch('/api/compatibilities/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: parseInt(productId), model_ids: selectedModelIds })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al guardar');

    alert(`✅ ${data.message}`);
    closeBulkCompatModal();
    await loadProducts();
    await loadCoverageData();
  } catch (err) {
    alert('❌ Error: ' + err.message);
  }
}

// GESTIÓN DE MARCAS Y MODELOS
function openBrandModal() { document.getElementById('modal-brand').classList.remove('hidden'); }
function closeBrandModal() { document.getElementById('modal-brand').classList.add('hidden'); }
async function saveBrand(e) {
  e.preventDefault();
  const name = document.getElementById('brand-name').value.trim();
  try {
    const res = await fetch('/api/brands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!res.ok) throw new Error('Error al guardar marca');
    closeBrandModal();
    document.getElementById('brand-name').value = '';
    await loadBrandsAndModels();
    await loadCoverageData();
  } catch (err) { alert('❌ Error: ' + err.message); }
}

function openModelModal() { 
  const sel = document.getElementById('model-brand-id');
  sel.innerHTML = BRANDS.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
  document.getElementById('modal-model').classList.remove('hidden'); 
}
function closeModelModal() { document.getElementById('modal-model').classList.add('hidden'); }
async function saveModel(e) {
  e.preventDefault();
  const brand_id = parseInt(document.getElementById('model-brand-id').value);
  const model_name = document.getElementById('model-name').value.trim();
  const release_year = parseInt(document.getElementById('model-year').value) || 2024;
  try {
    const res = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand_id, model_name, release_year })
    });
    if (!res.ok) throw new Error('Error al guardar modelo');
    closeModelModal();
    document.getElementById('model-name').value = '';
    await loadBrandsAndModels();
    await loadCoverageData();
  } catch (err) { alert('❌ Error: ' + err.message); }
}

async function deleteModel(id) {
  if (!confirm('¿Eliminar este modelo de celular?')) return;
  await fetch('/api/models/' + id, { method: 'DELETE' });
  await loadBrandsAndModels();
  await loadCoverageData();
}

// ==============================================================
// 4. PUNTO DE VENTA (POS) Y SELECTOR DE IMEIs
// ==============================================================
function populateBrandFilters() {
  const brandSelect = document.getElementById('pos-brand-filter');
  if (!brandSelect) return;
  brandSelect.innerHTML = '<option value="">-- Todas las Marcas --</option>' + 
    BRANDS.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
}

function onBrandFilterChange() {
  const brandId = document.getElementById('pos-brand-filter').value;
  const modelSelect = document.getElementById('pos-model-filter');

  if (!brandId) {
    modelSelect.innerHTML = '<option value="">-- Todos los Modelos --</option>';
  } else {
    const brandObj = BRANDS.find(b => String(b.id) === String(brandId));
    const models = brandObj ? brandObj.models : [];
    modelSelect.innerHTML = '<option value="">-- Todos los Modelos de ' + brandObj.name + ' --</option>' + 
      models.map(m => `<option value="${m.id}">${m.model_name}</option>`).join('');
  }
  renderProducts();
}

function clearModelFilters() {
  document.getElementById('pos-brand-filter').value = '';
  document.getElementById('pos-model-filter').innerHTML = '<option value="">-- Todos los Modelos --</option>';
  document.getElementById('search-input').value = '';
  renderProducts();
}

function renderProducts() {
  const selectedModelId = document.getElementById('pos-model-filter').value;
  const query = (document.getElementById('search-input').value || '').toLowerCase().trim();
  const grid = document.getElementById('product-grid');
  if (!grid) return;

  const filtered = PRODUCTS.filter(p => {
    let matchModel = true;
    if (selectedModelId) {
      matchModel = p.compatible_models && p.compatible_models.some(m => String(m.model_id) === String(selectedModelId));
    }
    const matchQuery = p.name.toLowerCase().includes(query) || p.code.toLowerCase().includes(query) || (p.category || '').toLowerCase().includes(query);
    return matchModel && matchQuery;
  });

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="col-span-full text-center py-12 text-gray-400 font-bold text-xs">No se encontraron productos ni accesorios compatibles.</div>`;
    return;
  }

  grid.innerHTML = filtered.map(p => {
    const isSerialized = p.is_serialized === 1;
    const modelBadges = (p.compatible_models || []).slice(0, 2).map(m => `
      <span class="bg-indigo-50 text-indigo-700 text-[9px] font-bold px-1.5 py-0.5 rounded border border-indigo-100">${m.model_name}</span>
    `).join('');

    return `
      <div onclick="handleProductClick(${p.id})" class="bg-white p-4 rounded-3xl border border-gray-200 shadow-sm hover:shadow-md transition-all cursor-pointer flex flex-col justify-between group">
        <div>
          <div class="flex justify-between items-start mb-1.5">
            <span class="bg-gray-100 text-gray-600 text-[9px] font-bold px-2 py-0.5 rounded-md truncate max-w-[110px]">${p.category}</span>
            ${isSerialized ? '<span class="bg-yellow-100 text-yellow-800 text-[9px] font-extrabold px-1.5 py-0.5 rounded">IMEI</span>' : ''}
          </div>
          <h3 class="font-bold text-gray-900 text-xs group-hover:text-indigo-600 transition-colors line-clamp-2">${p.name}</h3>
          <div class="mt-2 flex flex-wrap gap-1">${modelBadges}</div>
        </div>
        <div class="mt-4 flex justify-between items-end pt-2 border-t border-gray-100">
          <div>
            <p class="text-[10px] text-gray-400 font-bold">Stock: ${p.stock}</p>
            <p class="text-sm font-black text-indigo-600">S/ ${p.price.toFixed(2)}</p>
          </div>
          <button class="w-8 h-8 bg-indigo-50 text-indigo-600 rounded-xl flex items-center justify-center font-bold group-hover:bg-indigo-600 group-hover:text-white transition-all">
            <i class="fa-solid fa-plus text-xs"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function handleProductClick(productId) {
  const prod = PRODUCTS.find(p => p.id === productId);
  if (!prod || prod.stock <= 0) {
    alert('⚠️ Producto sin stock disponible.');
    return;
  }

  // Si requiere IMEI, abrir selector de IMEI
  if (prod.is_serialized === 1) {
    pendingImeiProduct = prod;
    document.getElementById('modal-imei-prod-name').innerText = `${prod.name} (#${prod.code})`;
    const listContainer = document.getElementById('modal-imei-list');
    listContainer.innerHTML = '<p class="text-xs text-gray-400">Consultando IMEIs disponibles...</p>';
    document.getElementById('modal-select-imei').classList.remove('hidden');

    try {
      const res = await fetch(`/api/imeis/available/${productId}`);
      const imeis = await res.json();
      if (imeis.length === 0) {
        listContainer.innerHTML = '<p class="text-xs text-red-500 font-bold">⚠️ No hay IMEIs registrados disponibles para este equipo.</p>';
        return;
      }
      listContainer.innerHTML = imeis.map(i => `
        <div onclick="selectImeiForSale('${i.imei_code}')" class="p-2.5 bg-gray-50 hover:bg-indigo-50 rounded-xl border border-gray-200 hover:border-indigo-300 cursor-pointer flex justify-between items-center">
          <span class="font-mono text-xs font-black text-gray-800">${i.imei_code}</span>
          <span class="text-[10px] font-bold text-indigo-600 bg-indigo-100 px-2 py-0.5 rounded">Asignar</span>
        </div>
      `).join('');
    } catch (e) {
      listContainer.innerHTML = '<p class="text-xs text-red-500">Error al cargar IMEIs</p>';
    }
  } else {
    addToCart(productId);
  }
}

function selectImeiForSale(imeiCode) {
  if (!pendingImeiProduct) return;

  const alreadyInCart = CART.find(i => i.imei === imeiCode);
  if (alreadyInCart) {
    alert('⚠️ Este IMEI ya está agregado en el carrito.');
    return;
  }

  CART.push({
    product: pendingImeiProduct,
    quantity: 1,
    imei: imeiCode
  });

  closeImeiSelectModal();
  renderCart();
}

function closeImeiSelectModal() {
  document.getElementById('modal-select-imei').classList.add('hidden');
  pendingImeiProduct = null;
}

function addToCart(productId) {
  const prod = PRODUCTS.find(p => p.id === productId);
  if (!prod || prod.stock <= 0) {
    alert('⚠️ Producto sin stock.');
    return;
  }

  const existing = CART.find(i => i.product.id === productId && !i.imei);
  if (existing) {
    if (existing.quantity >= prod.stock) {
      alert(`⚠️ Stock máximo alcanzado (${prod.stock} und).`);
      return;
    }
    existing.quantity += 1;
  } else {
    CART.push({ product: prod, quantity: 1, imei: '' });
  }

  renderCart();
}

function updateCartQty(productId, delta, imei = '') {
  const item = CART.find(i => i.product.id === productId && i.imei === imei);
  if (!item) return;

  if (item.imei) {
    CART = CART.filter(i => !(i.product.id === productId && i.imei === imei));
  } else {
    item.quantity += delta;
    if (item.quantity <= 0) {
      CART = CART.filter(i => !(i.product.id === productId && !i.imei));
    }
  }
  renderCart();
}

function clearCart() {
  CART = [];
  renderCart();
}

function renderCart() {
  const container = document.getElementById('cart-items');
  if (CART.length === 0) {
    container.innerHTML = `<div class="text-center py-12 text-gray-400 font-bold text-xs">Carrito vacío</div>`;
    document.getElementById('summary-subtotal').innerText = 'S/ 0.00';
    document.getElementById('summary-tax').innerText = 'S/ 0.00';
    document.getElementById('summary-total').innerText = 'S/ 0.00';
    document.getElementById('btn-pay').disabled = true;
    return;
  }

  let total = 0;
  container.innerHTML = CART.map(i => {
    const itemSub = i.product.price * i.quantity;
    total += itemSub;
    const imeiTag = i.imei ? `<p class="text-[10px] font-mono font-bold text-yellow-800 bg-yellow-50 px-1 rounded inline-block">IMEI: ${i.imei}</p>` : '';

    return `
      <div class="py-2.5 flex justify-between items-center gap-2">
        <div class="flex-1 min-w-0">
          <p class="font-bold text-xs text-gray-800 truncate">${i.product.name}</p>
          ${imeiTag}
          <p class="text-[10px] text-gray-400">S/ ${i.product.price.toFixed(2)} c/u</p>
        </div>
        <div class="flex items-center gap-1.5">
          ${!i.imei ? `
            <button onclick="updateCartQty(${i.product.id}, -1)" class="w-5 h-5 bg-gray-100 rounded text-xs font-bold">-</button>
            <span class="text-xs font-bold w-4 text-center">${i.quantity}</span>
            <button onclick="updateCartQty(${i.product.id}, 1)" class="w-5 h-5 bg-gray-100 rounded text-xs font-bold">+</button>
          ` : `
            <button onclick="updateCartQty(${i.product.id}, -1, '${i.imei}')" class="text-red-500 hover:text-red-700 text-xs font-bold px-1.5"><i class="fa-solid fa-trash"></i></button>
          `}
        </div>
        <span class="font-black text-xs text-gray-900 w-14 text-right">S/ ${itemSub.toFixed(2)}</span>
      </div>
    `;
  }).join('');

  const sub = total / 1.18;
  const tax = total - sub;
  document.getElementById('summary-subtotal').innerText = `S/ ${sub.toFixed(2)}`;
  document.getElementById('summary-tax').innerText = `S/ ${tax.toFixed(2)}`;
  document.getElementById('summary-total').innerText = `S/ ${total.toFixed(2)}`;
  document.getElementById('btn-pay').disabled = false;
}

// ==============================================================
// 5. MODAL DE PAGO, CÁLCULO DE VUELTO & EMISIÓN DE TICKET
// ==============================================================
function populateCustomerDropdown() {
  const select = document.getElementById('modal-select-customer');
  if (select) {
    select.innerHTML = '<option value="">Público General</option>' + 
      CLIENTS.map(c => `<option value="${c.id}">${c.name} (${c.doc}) ${c.debt > 0 ? '- Deuda: S/ ' + c.debt.toFixed(2) : ''}</option>`).join('');
  }
}

function openPaymentModal() {
  const total = CART.reduce((sum, i) => sum + (i.product.price * i.quantity), 0);
  document.getElementById('modal-pay-total').innerText = `S/ ${total.toFixed(2)}`;
  document.getElementById('tendered-amount').value = total.toFixed(2);
  calculateChange();
  document.getElementById('modal-payment').classList.remove('hidden');
}

function closePaymentModal() {
  document.getElementById('modal-payment').classList.add('hidden');
}

function setPaymentMethod(method) {
  selectedPaymentMethod = method;
  document.querySelectorAll('.pay-btn').forEach(b => {
    b.className = 'pay-btn bg-gray-100 text-gray-700 font-bold py-2.5 rounded-xl text-xs';
  });
  const activeBtn = document.getElementById('pay-' + method);
  if (activeBtn) activeBtn.className = 'pay-btn active bg-indigo-600 text-white font-bold py-2.5 rounded-xl text-xs';

  const cashBox = document.getElementById('cash-calculator-box');
  if (method === 'Efectivo') cashBox.classList.remove('hidden');
  else cashBox.classList.add('hidden');
}

function calculateChange() {
  const total = CART.reduce((sum, i) => sum + (i.product.price * i.quantity), 0);
  const tendered = parseFloat(document.getElementById('tendered-amount').value) || 0;
  const change = Math.max(0, tendered - total);
  document.getElementById('change-amount-display').innerText = `S/ ${change.toFixed(2)}`;
}

async function processFinalSale() {
  const customerId = document.getElementById('modal-select-customer').value;
  const customerObj = CLIENTS.find(c => String(c.id) === String(customerId));
  const customerName = customerObj ? customerObj.name : 'Público General';
  const docType = document.getElementById('modal-doc-type').value;

  if (selectedPaymentMethod === 'Fiado' && !customerId) {
    alert('⚠️ Debe seleccionar un cliente registrado para la opción de FIADO.');
    return;
  }

  const total = CART.reduce((sum, i) => sum + (i.product.price * i.quantity), 0);
  const tendered = parseFloat(document.getElementById('tendered-amount').value) || total;
  const change = Math.max(0, tendered - total);

  const payload = {
    doc_type: docType,
    customer_id: customerId ? parseInt(customerId) : null,
    customer_name: customerName,
    payment_method: selectedPaymentMethod,
    paid_amount: tendered,
    change_amount: change,
    items: CART.map(i => ({
      product_id: i.product.id,
      product_name: i.product.name,
      quantity: i.quantity,
      unit_price: i.product.price,
      imei: i.imei || ''
    }))
  };

  try {
    const res = await fetch('/api/sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al emitir venta');

    closePaymentModal();
    clearCart();
    await loadProducts();
    await loadCustomers();
    await loadDashboard();

    // Mostrar Ticket Térmico
    renderThermalTicket(data.sale);
    document.getElementById('modal-ticket').classList.remove('hidden');

  } catch (err) {
    alert('❌ Error: ' + err.message);
  }
}

function renderThermalTicket(sale) {
  const container = document.getElementById('thermal-ticket-container');
  if (!container) return;

  const dateStr = new Date(sale.created_at || Date.now()).toLocaleString();
  const itemsHtml = (sale.items || []).map(i => `
    <div class="flex justify-between py-1 border-b border-dashed border-gray-300">
      <div class="flex-1 min-w-0 pr-2">
        <p class="font-bold text-[11px]">${i.quantity}x ${i.product_name}</p>
        ${i.imei_code ? `<p class="text-[10px] font-black text-gray-900">IMEI: ${i.imei_code}</p>` : ''}
      </div>
      <span class="font-bold">S/ ${(i.quantity * i.unit_price).toFixed(2)}</span>
    </div>
  `).join('');

  container.innerHTML = `
    <div class="text-center pb-2 border-b border-dashed border-gray-300">
      <h2 class="font-black text-sm tracking-wider">CELLVENTAS</h2>
      <p class="text-[10px] font-bold">VENTA DE CELULARES Y ACCESORIOS</p>
      <p class="text-[10px]">VT VALETEC</p>
      <p class="text-[10px] mt-1 font-bold">${sale.doc_type.toUpperCase()}: ${sale.receipt_code}</p>
      <p class="text-[9px] text-gray-500">${dateStr}</p>
    </div>

    <div class="py-1.5 border-b border-dashed border-gray-300 text-[10px]">
      <p><span class="font-bold">Cliente:</span> ${sale.customer_name}</p>
      <p><span class="font-bold">Pago:</span> ${sale.payment_method}</p>
    </div>

    <div class="py-1">
      ${itemsHtml}
    </div>

    <div class="pt-2 border-t border-dashed border-gray-300 space-y-1 text-right text-[11px]">
      <div class="flex justify-between"><span>Subtotal:</span><span>S/ ${sale.subtotal.toFixed(2)}</span></div>
      <div class="flex justify-between"><span>IGV (18%):</span><span>S/ ${sale.tax.toFixed(2)}</span></div>
      <div class="flex justify-between font-black text-sm pt-1 border-t border-gray-300">
        <span>TOTAL:</span><span>S/ ${sale.total.toFixed(2)}</span>
      </div>
      ${sale.payment_method === 'Efectivo' ? `
        <div class="flex justify-between text-[10px] text-gray-600"><span>Recibido:</span><span>S/ ${sale.paid_amount.toFixed(2)}</span></div>
        <div class="flex justify-between text-[10px] text-gray-600"><span>Vuelto:</span><span>S/ ${sale.change_amount.toFixed(2)}</span></div>
      ` : ''}
    </div>

    <div class="text-center pt-3 text-[9px] text-gray-500 border-t border-dashed border-gray-300">
      <p>¡Gracias por su preferencia!</p>
      <p>Garantía de equipos con presentación de comprobante.</p>
    </div>
  `;
}

function closeTicketModal() {
  document.getElementById('modal-ticket').classList.add('hidden');
}

// ==============================================================
// 6. HISTORIAL DE VENTAS & ANULACIONES
// ==============================================================
async function loadSalesHistory() {
  try {
    const res = await fetch('/api/sales');
    SALES = await res.json();
    renderSalesHistoryTable();
  } catch (err) {
    console.error('Error cargando ventas:', err);
  }
}

function renderSalesHistoryTable() {
  const tbody = document.getElementById('sales-table-body');
  if (!tbody) return;

  const query = (document.getElementById('sales-search')?.value || '').toLowerCase().trim();
  const filtered = SALES.filter(s => 
    s.receipt_code.toLowerCase().includes(query) || 
    (s.customer_name || '').toLowerCase().includes(query) ||
    s.payment_method.toLowerCase().includes(query)
  );

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="p-8 text-center text-gray-400 font-bold">No hay comprobantes de venta registrados.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(s => {
    const isAnulada = s.status === 'anulada';
    const itemsPreview = (s.items || []).map(i => `${i.quantity}x ${i.product_name} ${i.imei_code ? '<span class="font-mono text-[9px] bg-yellow-50 text-yellow-800 px-1 rounded">(IMEI: ' + i.imei_code + ')</span>' : ''}`).join('<br>');

    return `
      <tr class="hover:bg-gray-50 ${isAnulada ? 'opacity-50 line-through' : ''}">
        <td class="p-4 font-mono font-bold text-gray-800 text-xs">${s.receipt_code}</td>
        <td class="p-4 text-gray-500 text-[11px]">${new Date(s.created_at).toLocaleString()}</td>
        <td class="p-4 font-bold text-gray-800 text-xs">${s.customer_name}</td>
        <td class="p-4"><span class="bg-gray-100 text-gray-700 px-2 py-0.5 rounded text-[10px] font-bold">${s.payment_method}</span></td>
        <td class="p-4 text-[11px] text-gray-600">${itemsPreview}</td>
        <td class="p-4 text-right font-black text-gray-900 text-xs">S/ ${parseFloat(s.total).toFixed(2)}</td>
        <td class="p-4 text-center">
          <span class="px-2.5 py-1 rounded-full text-[10px] font-black ${isAnulada ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}">
            ${s.status.toUpperCase()}
          </span>
        </td>
        <td class="p-4 text-center">
          <div class="flex items-center justify-center gap-2">
            <button onclick="reprintTicket(${s.id})" class="text-indigo-600 hover:text-indigo-800 font-bold text-xs" title="Ver / Imprimir Ticket"><i class="fa-solid fa-print"></i></button>
            ${!isAnulada ? `
              <button onclick="anularSale(${s.id}, '${s.receipt_code}')" class="text-red-500 hover:text-red-700 font-bold text-xs" title="Anular Venta"><i class="fa-solid fa-ban"></i></button>
            ` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function reprintTicket(saleId) {
  try {
    const res = await fetch(`/api/sales/${saleId}`);
    const sale = await res.json();
    renderThermalTicket(sale);
    document.getElementById('modal-ticket').classList.remove('hidden');
  } catch (err) {
    alert('❌ Error al cargar comprobante: ' + err.message);
  }
}

async function anularSale(saleId, code) {
  if (!confirm(`¿Está seguro de ANULAR la venta #${code}?\n\n- Se restituirá el stock al almacén.\n- Se liberarán los códigos IMEI correspondientes.\n- Si fue al crédito/fiado, se descontará la deuda.`)) return;

  try {
    const res = await fetch(`/api/sales/${saleId}/anular`, { method: 'PUT' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al anular venta');

    alert(`✅ ${data.message}`);
    await loadSalesHistory();
    await loadProducts();
    await loadCustomers();
    await loadDashboard();
  } catch (err) {
    alert('❌ Error: ' + err.message);
  }
}

// ==============================================================
// 7. RASTREADOR Y GESTIÓN DE IMEIS
// ==============================================================
async function searchImeiTracker() {
  const query = (document.getElementById('imei-tracker-input')?.value || '').trim();
  const container = document.getElementById('imei-tracker-results');
  if (!container) return;

  if (!query) {
    container.innerHTML = '<div class="text-center py-8 text-gray-400 font-medium text-xs">Escriba un código IMEI (ej. 8642...) para ver su trazabilidad.</div>';
    return;
  }

  container.innerHTML = '<div class="text-center py-6 text-gray-400 text-xs font-bold"><i class="fa-solid fa-spinner fa-spin mr-2"></i> Buscando IMEI...</div>';

  try {
    const res = await fetch(`/api/imeis/search/${query}`);
    const results = await res.json();

    if (results.length === 0) {
      container.innerHTML = '<div class="text-center py-8 text-red-500 font-bold text-xs">⚠️ No se encontró ningún teléfono registrado con ese código IMEI.</div>';
      return;
    }

    container.innerHTML = results.map(i => {
      const isVendido = i.status === 'vendido';
      return `
        <div class="bg-gray-50 p-4 rounded-2xl border border-gray-200 flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
          <div>
            <div class="flex items-center gap-2">
              <span class="font-mono font-black text-sm text-gray-900">${i.imei_code}</span>
              <span class="px-2 py-0.5 rounded text-[10px] font-black ${isVendido ? 'bg-yellow-100 text-yellow-800' : 'bg-green-100 text-green-800'}">
                ${i.status.toUpperCase()}
              </span>
            </div>
            <p class="text-xs font-bold text-gray-700 mt-1">${i.product_name} <span class="text-gray-400 font-mono">(#${i.product_code})</span></p>
          </div>
          <div class="text-xs text-gray-500 space-y-0.5 md:text-right">
            ${isVendido ? `
              <p><span class="font-bold text-gray-700">Comprobante:</span> ${i.receipt_code}</p>
              <p><span class="font-bold text-gray-700">Cliente:</span> ${i.customer_name}</p>
              <p><span class="font-bold text-gray-700">Fecha Venta:</span> ${new Date(i.sold_at || i.sale_date).toLocaleString()}</p>
            ` : `
              <p class="text-green-700 font-bold"><i class="fa-solid fa-check mr-1"></i> Disponible en vitrina / stock</p>
              <p class="text-[10px] text-gray-400">Ingresado: ${new Date(i.created_at).toLocaleDateString()}</p>
            `}
          </div>
        </div>
      `;
    }).join('');

  } catch (err) {
    container.innerHTML = `<div class="p-4 bg-red-50 text-red-700 rounded-xl text-xs font-bold">Error: ${err.message}</div>`;
  }
}

function openImeiEntryModal() {
  const prodSelect = document.getElementById('imei-entry-product-id');
  const serializedProds = PRODUCTS.filter(p => p.is_serialized === 1);
  if (serializedProds.length === 0) {
    alert('⚠️ No hay celulares configurados como "Equipos Celulares con IMEI". Registre uno primero en Inventario.');
    return;
  }
  prodSelect.innerHTML = serializedProds.map(p => `<option value="${p.id}">${p.name} (#${p.code})</option>`).join('');
  document.getElementById('modal-imei-entry').classList.remove('hidden');
}

function closeImeiEntryModal() {
  document.getElementById('modal-imei-entry').classList.add('hidden');
}

async function saveImeiBatch(e) {
  e.preventDefault();
  const product_id = parseInt(document.getElementById('imei-entry-product-id').value);
  const rawText = document.getElementById('imei-entry-codes').value;
  const imeis = rawText.split('\n').map(s => s.trim()).filter(s => s.length > 0);

  if (imeis.length === 0) {
    alert('⚠️ Ingrese al menos un código IMEI.');
    return;
  }

  try {
    const res = await fetch('/api/imeis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id, imeis })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al guardar IMEIs');

    alert(`✅ ${data.message}`);
    closeImeiEntryModal();
    document.getElementById('imei-entry-codes').value = '';
    await loadProducts();
    if (document.getElementById('imei-tracker-input').value) searchImeiTracker();
  } catch (err) {
    alert('❌ Error: ' + err.message);
  }
}

// ==============================================================
// 8. CONTROL DE CAJA Y ARQUEO Z
// ==============================================================
async function loadCashStatus() {
  const panel = document.getElementById('cash-status-panel');
  if (!panel) return;

  try {
    const res = await fetch('/api/cash/status');
    const data = await res.json();

    if (!data.isOpen) {
      panel.innerHTML = `
        <div class="bg-white p-8 rounded-3xl border border-gray-200 shadow-sm max-w-md mx-auto text-center space-y-4">
          <div class="w-16 h-16 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center text-2xl mx-auto">
            <i class="fa-solid fa-lock"></i>
          </div>
          <h3 class="text-lg font-black text-gray-800">Caja de Turno Cerrada</h3>
          <p class="text-xs text-gray-500">Para procesar ventas y registrar movimientos de mostrador, abra el turno de caja.</p>
          <div class="space-y-3 pt-2 text-left">
            <div>
              <label class="text-xs font-bold text-gray-600 block mb-1">Monto Inicial en Efectivo (S/):</label>
              <input type="number" step="0.50" id="cash-open-amount" value="50.00" class="w-full p-2.5 border border-gray-300 rounded-xl text-xs font-black outline-none focus:ring-2 focus:ring-indigo-500">
            </div>
            <button onclick="openCashRegister()" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-black py-3 rounded-xl text-xs shadow-md uppercase">
              <i class="fa-solid fa-key mr-1"></i> Abrir Caja de Hoy
            </button>
          </div>
        </div>
      `;
    } else {
      const reg = data.register;
      panel.innerHTML = `
        <div class="space-y-6">
          <!-- TARJETAS DE ARQUEO EN VIVO -->
          <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div class="bg-white p-5 rounded-3xl border border-gray-200 shadow-sm">
              <p class="text-[10px] uppercase font-bold text-gray-400">Saldo Inicial</p>
              <p class="text-xl font-black text-gray-800">S/ ${data.initialAmount.toFixed(2)}</p>
              <p class="text-[10px] text-gray-400 mt-1">Apertura: ${new Date(reg.opened_at).toLocaleTimeString()}</p>
            </div>
            <div class="bg-white p-5 rounded-3xl border border-gray-200 shadow-sm">
              <p class="text-[10px] uppercase font-bold text-gray-400">Ventas en Efectivo</p>
              <p class="text-xl font-black text-green-600">S/ ${data.efectivoSales.toFixed(2)}</p>
              <p class="text-[10px] text-gray-400 mt-1">Yape/Plin: S/ ${data.yapeSales.toFixed(2)}</p>
            </div>
            <div class="bg-white p-5 rounded-3xl border border-gray-200 shadow-sm">
              <p class="text-[10px] uppercase font-bold text-gray-400">Ingresos / Retiros</p>
              <p class="text-xs font-bold text-green-600">+ S/ ${data.ingresos.toFixed(2)} (Ingresos)</p>
              <p class="text-xs font-bold text-red-600">- S/ ${data.retiros.toFixed(2)} (Gastos)</p>
            </div>
            <div class="bg-gradient-to-tr from-gray-900 to-indigo-950 p-5 rounded-3xl text-white shadow-lg">
              <p class="text-[10px] uppercase font-bold text-indigo-300">Efectivo Esperado en Caja</p>
              <p class="text-2xl font-black text-white">S/ ${data.expectedCash.toFixed(2)}</p>
              <p class="text-[10px] text-gray-400 mt-1">Total vendido: S/ ${data.totalSales.toFixed(2)}</p>
            </div>
          </div>

          <!-- BOTONES DE ACCIÓN: MOVIMIENTO Y CIERRE -->
          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <!-- REGISTRAR MOVIMIENTO -->
            <div class="bg-white p-5 rounded-3xl border border-gray-200 shadow-sm space-y-3">
              <h4 class="font-black text-sm text-gray-800 flex items-center gap-2">
                <i class="fa-solid fa-money-bill-transfer text-indigo-600"></i> Registrar Movimiento Manual
              </h4>
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="text-[10px] font-bold text-gray-500 uppercase">Tipo</label>
                  <select id="mov-type" class="w-full p-2 border border-gray-200 rounded-xl text-xs font-bold outline-none">
                    <option value="RETIRO">Gasto / Retiro</option>
                    <option value="INGRESO">Ingreso Extra</option>
                  </select>
                </div>
                <div>
                  <label class="text-[10px] font-bold text-gray-500 uppercase">Monto (S/)</label>
                  <input type="number" step="0.50" id="mov-amount" placeholder="0.00" class="w-full p-2 border border-gray-200 rounded-xl text-xs font-bold outline-none">
                </div>
              </div>
              <div>
                <label class="text-[10px] font-bold text-gray-500 uppercase">Motivo / Detalle</label>
                <input type="text" id="mov-reason" placeholder="Ej. Pago de almuerzo, cambio sencillo..." class="w-full p-2 border border-gray-200 rounded-xl text-xs outline-none">
              </div>
              <button onclick="registerCashMovement()" class="w-full bg-gray-800 hover:bg-gray-900 text-white font-bold py-2.5 rounded-xl text-xs shadow-sm">
                Guardar Movimiento
              </button>
            </div>

            <!-- CIERRE DE CAJA / ARQUEO Z -->
            <div class="bg-white p-5 rounded-3xl border border-gray-200 shadow-sm space-y-3">
              <h4 class="font-black text-sm text-gray-800 flex items-center gap-2">
                <i class="fa-solid fa-file-invoice-dollar text-green-600"></i> Realizar Corte de Caja (Arqueo Z)
              </h4>
              <div>
                <label class="text-[10px] font-bold text-gray-500 uppercase">Efectivo Real en Caja (S/) *</label>
                <input type="number" step="0.50" id="close-final-amount" placeholder="Monto contado físicamente..." class="w-full p-2 border border-gray-200 rounded-xl text-xs font-black outline-none text-indigo-700 text-sm">
              </div>
              <div>
                <label class="text-[10px] font-bold text-gray-500 uppercase">Observaciones</label>
                <input type="text" id="close-notes" placeholder="Notas de cierre (opcional)..." class="w-full p-2 border border-gray-200 rounded-xl text-xs outline-none">
              </div>
              <button onclick="closeCashRegister()" class="w-full bg-red-600 hover:bg-red-700 text-white font-black py-2.5 rounded-xl text-xs shadow-sm uppercase">
                <i class="fa-solid fa-lock mr-1"></i> Cerrar Caja y Generar Arqueo Z
              </button>
            </div>
          </div>
        </div>
      `;
    }
  } catch (err) {
    console.error('Error cargando caja:', err);
  }
}

async function openCashRegister() {
  const amount = parseFloat(document.getElementById('cash-open-amount').value) || 0;
  try {
    const res = await fetch('/api/cash/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initial_amount: amount })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error');
    await loadCashStatus();
  } catch (err) { alert('❌ Error: ' + err.message); }
}

async function registerCashMovement() {
  const type = document.getElementById('mov-type').value;
  const amount = parseFloat(document.getElementById('mov-amount').value);
  const reason = document.getElementById('mov-reason').value.trim();

  if (!amount || amount <= 0 || !reason) {
    alert('⚠️ Ingrese un monto válido y el motivo.');
    return;
  }

  try {
    const res = await fetch('/api/cash/movement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, amount, reason })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error');
    await loadCashStatus();
  } catch (err) { alert('❌ Error: ' + err.message); }
}

async function closeCashRegister() {
  const finalAmount = parseFloat(document.getElementById('close-final-amount').value);
  const notes = document.getElementById('close-notes').value.trim();

  if (isNaN(finalAmount)) {
    alert('⚠️ Ingrese el monto físico contado en caja.');
    return;
  }

  if (!confirm('¿Está seguro de cerrar el turno de caja y generar el Arqueo Z?')) return;

  try {
    const res = await fetch('/api/cash/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ final_amount: finalAmount, notes })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error');

    const s = data.summary;
    alert(`📊 Arqueo Z Generado:\n\n- Esperado: S/ ${s.expectedAmount.toFixed(2)}\n- Contado: S/ ${s.finalAmount.toFixed(2)}\n- Diferencia: S/ ${s.difference.toFixed(2)}`);
    await loadCashStatus();
  } catch (err) { alert('❌ Error: ' + err.message); }
}

// ==============================================================
// 9. INVENTARIO, CRM & FIADOS
// ==============================================================
function populateModelCheckboxes() {
  const container = document.getElementById('product-model-checkboxes');
  if (!container) return;

  let html = '';
  BRANDS.forEach(b => {
    if (b.models && b.models.length > 0) {
      html += `<div class="col-span-full font-black text-indigo-900 text-[10px] uppercase border-b border-indigo-100 pt-1 mt-1">${b.name}</div>`;
      b.models.forEach(m => {
        html += `
          <label class="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" name="compat_models" value="${m.id}" class="rounded text-indigo-600">
            <span>${m.model_name}</span>
          </label>
        `;
      });
    }
  });
  container.innerHTML = html;
}

function toggleSerializedCheckbox() {
  const cat = document.getElementById('prod-category').value;
  const container = document.getElementById('is-serialized-container');
  const checkbox = document.getElementById('prod-serialized');
  if (cat === 'Equipos Celulares') {
    container.classList.remove('hidden');
    checkbox.checked = true;
  } else {
    container.classList.add('hidden');
    checkbox.checked = false;
  }
}

function openProductModal() { 
  document.getElementById('modal-product').classList.remove('hidden'); 
  toggleSerializedCheckbox();
}
function closeProductModal() { document.getElementById('modal-product').classList.add('hidden'); }

async function saveProduct(e) {
  e.preventDefault();
  const selectedModelIds = Array.from(document.querySelectorAll('input[name="compat_models"]:checked')).map(cb => parseInt(cb.value));

  const payload = {
    code: document.getElementById('prod-code').value.trim(),
    name: document.getElementById('prod-name').value.trim(),
    category: document.getElementById('prod-category').value,
    purchase_price: parseFloat(document.getElementById('prod-purchase').value) || 0,
    price: parseFloat(document.getElementById('prod-price').value),
    stock: parseInt(document.getElementById('prod-stock').value) || 0,
    is_serialized: document.getElementById('prod-serialized')?.checked ? 1 : 0,
    model_ids: selectedModelIds
  };

  try {
    const res = await fetch('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Error al guardar producto');
    closeProductModal();
    await loadProducts();
    await loadCoverageData();
    alert('✅ Producto guardado con su matriz de compatibilidad.');
  } catch (err) { alert('❌ Error: ' + err.message); }
}

function renderInventoryTable() {
  const tbody = document.getElementById('inventory-table-body');
  if (!tbody) return;

  const query = (document.getElementById('inv-search')?.value || '').toLowerCase().trim();
  const filtered = PRODUCTS.filter(p => 
    p.name.toLowerCase().includes(query) || 
    p.code.toLowerCase().includes(query) || 
    (p.category || '').toLowerCase().includes(query)
  );

  tbody.innerHTML = filtered.map(p => {
    const modelsStr = (p.compatible_models || []).map(m => m.model_name).join(', ') || 'Universal';
    return `
      <tr class="hover:bg-gray-50">
        <td class="p-4 font-mono font-bold text-gray-500 text-xs">${p.code}</td>
        <td class="p-4 font-bold text-gray-900 text-xs">${p.name}</td>
        <td class="p-4"><span class="bg-gray-100 text-gray-700 px-2 py-0.5 rounded text-[10px] font-bold">${p.category}</span></td>
        <td class="p-4 text-xs text-indigo-700 font-medium truncate max-w-xs">${modelsStr}</td>
        <td class="p-4 text-right font-bold text-gray-500 text-xs">S/ ${(p.purchase_price || 0).toFixed(2)}</td>
        <td class="p-4 text-right font-black text-gray-900 text-xs">S/ ${p.price.toFixed(2)}</td>
        <td class="p-4 text-center">
          <span class="${p.stock < 5 ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'} px-2.5 py-0.5 rounded font-black text-xs">
            ${p.stock} und.
          </span>
        </td>
        <td class="p-4 text-center">
          <button onclick="deleteProduct(${p.id})" class="text-red-500 hover:text-red-700 font-bold text-xs"><i class="fa-solid fa-trash"></i></button>
        </td>
      </tr>
    `;
  }).join('');
}

async function deleteProduct(id) {
  if (!confirm('¿Eliminar este producto del almacén?')) return;
  await fetch('/api/products/' + id, { method: 'DELETE' });
  await loadProducts();
  await loadCoverageData();
}

function renderFiadosTable() {
  const tbody = document.getElementById('fiados-table-body');
  if (!tbody) return;
  tbody.innerHTML = CLIENTS.map(c => `
    <tr class="hover:bg-gray-50">
      <td class="p-4 font-mono font-bold text-gray-500 text-xs">${c.doc}</td>
      <td class="p-4 font-bold text-gray-800 text-xs">${c.name}</td>
      <td class="p-4 text-gray-500 text-xs">${c.phone || '-'}</td>
      <td class="p-4 text-right font-black ${c.debt > 0 ? 'text-yellow-600' : 'text-gray-400'} text-xs">S/ ${(c.debt || 0).toFixed(2)}</td>
      <td class="p-4 text-center"><button onclick="registerAbono(${c.id})" class="bg-yellow-500 hover:bg-yellow-600 text-white font-bold px-3 py-1 rounded-xl text-xs shadow-sm">Abonar</button></td>
    </tr>
  `).join('');
}

async function registerAbono(customerId) {
  const amountStr = prompt('Monto a abonar (S/):');
  if (!amountStr) return;
  const amount = parseFloat(amountStr);
  if (!amount || amount <= 0) return;

  try {
    const res = await fetch('/api/fiados/abono', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_id: customerId, amount })
    });
    if (!res.ok) throw new Error('Error al registrar abono');
    alert('✅ Abono registrado correctamente.');
    await loadCustomers();
  } catch (err) { alert('❌ Error: ' + err.message); }
}

function openCustomerModal() {
  const doc = prompt('DNI / RUC del cliente:');
  if (!doc) return;
  const name = prompt('Nombre completo o Razón Social:');
  if (!name) return;
  const phone = prompt('Teléfono (opcional):') || '';

  fetch('/api/customers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ doc, name, phone })
  }).then(() => loadCustomers());
}

window.onload = init;
