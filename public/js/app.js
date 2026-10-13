// CELLVENTAS - Asistente de Compatibilidades, Matriz Multimodelo & POS Especializado
// by VT VALETEC

let BRANDS = [];
let PRODUCTS = [];
let CLIENTS = [];
let SALES = [];
let COVERAGE = [];
let CART = [];
let REPAIRS = [];
let CASH_HISTORY = [];
let isCashRegisterOpen = false;
let selectedPaymentMethod = 'Efectivo';
let pendingImeiProduct = null;
let currentCoverageFilter = 'all';
let currentRepairFilter = 'all';

let currentUser = null;
let authToken = localStorage.getItem('cellventas_token') || '';

// Helper para cabeceras HTTP con autorización JWT
function getAuthHeaders(includeJson = true) {
  const headers = {};
  if (includeJson) headers['Content-Type'] = 'application/json';
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  return headers;
}

// Conexión WebSockets
const socket = typeof io !== 'undefined' ? io() : null;
if (socket) {
  socket.on('sale_completed', () => { loadDashboard(); loadSalesHistory(); loadCashStatus(); });
  socket.on('sale_annulled', () => { loadProducts(); loadDashboard(); loadSalesHistory(); loadCashStatus(); });
  socket.on('product_updated', () => { 
    loadProducts(); 
    loadBrandsAndModels(); 
    loadDashboard(); 
    if (typeof refreshCurrentKardex === 'function' && document.getElementById('modal-kardex') && !document.getElementById('modal-kardex').classList.contains('hidden')) {
      refreshCurrentKardex();
    }
  });
  socket.on('inventory_movement_added', () => { 
    loadProducts(); 
    if (typeof refreshCurrentKardex === 'function' && document.getElementById('modal-kardex') && !document.getElementById('modal-kardex').classList.contains('hidden')) {
      refreshCurrentKardex();
    }
  });
  socket.on('compatibility_updated', () => { loadBrandsAndModels(); loadCoverageData(); });
  socket.on('cash_updated', () => { loadCashStatus(); loadCashHistory(); });
  socket.on('abono_registered', () => { loadCustomers(); loadCashStatus(); loadDashboard(); });
  socket.on('repair_updated', () => { loadRepairs(); loadDashboard(); });
}

// Inicialización
async function init() {
  setupKeyboardShortcuts();
  const isAuthenticated = await checkAuthSession();
  if (!isAuthenticated) {
    showLoginScreen();
    return;
  }
  hideLoginScreen();
  updateUserSessionUI();
  await loadCashStatus();
  await loadCashHistory();
  await loadBrandsAndModels();
  await loadProducts();
  await loadCustomers();
  await loadRepairs();
  await loadDashboard();
  await loadCoverageData();
  await loadSalesHistory();
}

async function checkAuthSession() {
  if (!authToken) return false;
  try {
    const res = await fetch('/api/auth/me', { headers: getAuthHeaders(false) });
    if (!res.ok) throw new Error('Token inválido');
    const data = await res.json();
    if (data.authenticated && data.user) {
      currentUser = data.user;
      localStorage.setItem('cellventas_user', JSON.stringify(currentUser));
      return true;
    }
    return false;
  } catch (e) {
    authToken = '';
    currentUser = null;
    localStorage.removeItem('cellventas_token');
    localStorage.removeItem('cellventas_user');
    return false;
  }
}

function showLoginScreen() {
  const scr = document.getElementById('login-screen');
  if (scr) {
    scr.classList.remove('hidden');
    setTimeout(() => document.getElementById('login-screen-password')?.focus(), 100);
  }
}

function hideLoginScreen() {
  const scr = document.getElementById('login-screen');
  if (scr) scr.classList.add('hidden');
}

// Atajos de teclado rápidos de mostrador (F1, F2, F4, Ctrl+K, ESC)
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Buscador global omnibox con Ctrl+K o Cmd+K
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      const omnibox = document.getElementById('global-omnibox');
      if (omnibox) {
        omnibox.focus();
        omnibox.select();
      }
      return;
    }

    if (e.key === 'F1') {
      e.preventDefault();
      switchTab('assistant');
      setTimeout(() => document.getElementById('assistant-brand-select')?.focus(), 60);
    } else if (e.key === 'F2') {
      e.preventDefault();
      switchTab('pos');
      setTimeout(() => document.getElementById('search-input')?.focus(), 60);
    } else if (e.key === 'F4') {
      e.preventDefault();
      if (CART.length > 0) openPaymentModal();
    } else if (e.key === 'Escape') {
      if (isMegaMenuOpen) {
        toggleMegaMenu(false);
        return;
      }
      closePaymentModal();
      closeTicketModal();
      closeProductModal();
      closeCustomerModal();
      closeCustomerHistoryModal();
      closeRepairModal();
      closeRepairUpdateModal();
      closeLoginModal();
      closeAbonoModal();
      closeImeiSelectModal();
      closeImeiEntryModal();
      closeBulkCompatModal();
      closeBrandModal();
      closeModelModal();
      closeRequireCashModal();
      if (typeof closeKardexModal === 'function') closeKardexModal();
      if (typeof closeStockAdjustmentModal === 'function') closeStockAdjustmentModal();
      if (typeof closeUserManagementModal === 'function') closeUserManagementModal();
    }
  });
}

// Toast Flotante
function showToast(title, msg, type = 'success') {
  const toast = document.getElementById('toast-notification');
  const tTitle = document.getElementById('toast-title');
  const tMsg = document.getElementById('toast-msg');
  const tIcon = document.getElementById('toast-icon');

  if (!toast) return;

  tTitle.innerText = title;
  tMsg.innerText = msg;

  if (type === 'error') {
    tIcon.className = 'w-7 h-7 rounded-xl bg-rose-500 text-white flex items-center justify-center text-xs font-bold';
    tIcon.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i>';
  } else if (type === 'warning') {
    tIcon.className = 'w-7 h-7 rounded-xl bg-amber-500 text-white flex items-center justify-center text-xs font-bold';
    tIcon.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i>';
  } else {
    tIcon.className = 'w-7 h-7 rounded-xl bg-emerald-500 text-white flex items-center justify-center text-xs font-bold';
    tIcon.innerHTML = '<i class="fa-solid fa-check"></i>';
  }

  toast.classList.remove('translate-y-[-100px]', 'opacity-0', 'pointer-events-none');
  setTimeout(() => {
    toast.classList.add('translate-y-[-100px]', 'opacity-0', 'pointer-events-none');
  }, 3200);
}

const SECTION_TITLES = {
  'assistant': 'Asistente de Mostrador 360°',
  'pos': 'Punto de Venta (POS) & Carrito',
  'repairs': 'Taller & Servicio Técnico',
  'compatibility': 'Matriz & Auditoría de Compatibilidades',
  'inventory': 'Almacén, Precios & Stock',
  'imeis': 'Rastreador de Series / IMEIs',
  'cash': 'Control de Caja & Arqueo Z',
  'sales-history': 'Historial de Ventas & Anulaciones',
  'fiados': 'Cuentas por Cobrar & CRM',
  'dashboard': 'Dashboard & Reporte Ejecutivo'
};

// ==============================================================
// MENÚ LATERAL DESPLEGABLE COMPACTO & PURO (OVERLAY FLOTANTE)
// ==============================================================
let isMegaMenuOpen = false;

function toggleMegaMenu(forcedState) {
  const backdrop = document.getElementById('mega-menu-backdrop');
  const drawer = document.getElementById('mega-menu-drawer');
  const arrow = document.getElementById('menu-arrow-icon');

  isMegaMenuOpen = forcedState !== undefined ? Boolean(forcedState) : !isMegaMenuOpen;

  if (isMegaMenuOpen) {
    if (backdrop) {
      backdrop.classList.remove('opacity-0', 'pointer-events-none');
      backdrop.classList.add('opacity-100', 'pointer-events-auto');
    }
    if (drawer) {
      drawer.classList.remove('-translate-x-full');
      drawer.classList.add('translate-x-0');
    }
    if (arrow) arrow.style.transform = 'rotate(180deg)';
  } else {
    if (backdrop) {
      backdrop.classList.add('opacity-0', 'pointer-events-none');
      backdrop.classList.remove('opacity-100', 'pointer-events-auto');
    }
    if (drawer) {
      drawer.classList.add('-translate-x-full');
      drawer.classList.remove('translate-x-0');
    }
    if (arrow) arrow.style.transform = 'rotate(0deg)';
  }
}

function handleMenuNavigate(dest) {
  toggleMegaMenu(false);

  if (dest === 'kardex') {
    switchTab('inventory');
    if (typeof openGeneralKardexModal === 'function') {
      setTimeout(() => openGeneralKardexModal(), 100);
    }
    return;
  }

  switchTab(dest);
}

// Alias de compatibilidad
function handleMegaMenuLink(actionKey, deptKey) {
  toggleMegaMenu(false);
  const cleanKey = actionKey.replace('tab_', '').replace('action_', '');
  handleMenuNavigate(cleanKey);
}

function handleGlobalOmnibox(query) {
  const q = (query || '').trim();
  if (!q) return;

  // Si son 15 dígitos -> Rastreo directo de IMEI
  if (/^\d{15}$/.test(q)) {
    switchTab('imeis');
    const imeiInput = document.getElementById('imei-search-input');
    if (imeiInput) {
      imeiInput.value = q;
      searchImeiTracker();
      showToast('Buscador IMEI', `Rastreando serie de 15 dígitos: ${q}`);
    }
    return;
  }

  // Filtrado rápido en POS
  const posSearchInput = document.getElementById('search-input');
  if (posSearchInput) {
    if (document.getElementById('view-pos').classList.contains('hidden')) {
      switchTab('pos');
    }
    posSearchInput.value = q;
    filterProducts();
  }
}

function switchTab(tabId) {
  // Asegurar que el menú siempre se cierre al cambiar de vista
  toggleMegaMenu(false);

  // Sincronizar estilo activo en el menú lateral compacto
  document.querySelectorAll('.menu-nav-item').forEach(btn => btn.classList.remove('active'));
  const activeMenuBtn = document.getElementById('menu-btn-' + tabId);
  if (activeMenuBtn) activeMenuBtn.classList.add('active');

  document.querySelectorAll('.view-section').forEach(el => el.classList.add('hidden'));
  const target = document.getElementById('view-' + tabId);
  if (target) target.classList.remove('hidden');

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.className = 'nav-btn w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-slate-400 hover:bg-slate-800 hover:text-white font-semibold text-[13px] transition-all';
  });
  const activeBtn = document.getElementById('btn-tab-' + tabId);
  if (activeBtn) {
    activeBtn.className = 'nav-btn w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-700 text-white font-bold text-[13px] transition-all shadow-md';
  }

  const topbarTitle = document.getElementById('topbar-section-title');
  if (topbarTitle && SECTION_TITLES[tabId]) {
    topbarTitle.innerText = SECTION_TITLES[tabId];
  }

  if (tabId === 'assistant') { populateAssistantBrandDropdown(); updateAssistantCartBar(); }
  if (tabId === 'pos') { populateBrandFilters(); renderProducts(); renderCart(); }
  if (tabId === 'compatibility') { loadCoverageData(); renderCompatibilityMatrix(); }
  if (tabId === 'inventory') renderInventoryTable();
  if (tabId === 'imeis') searchImeiTracker();
  if (tabId === 'sales-history') loadSalesHistory();
  if (tabId === 'cash') { loadCashStatus(); loadCashHistory(); }
  if (tabId === 'fiados') renderFiadosTable();
  if (tabId === 'repairs') loadRepairs();
  if (tabId === 'dashboard') loadDashboard();
}

// ==============================================================
// 1. CARGADORES DE DATOS BASE
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

    const profitEl = document.getElementById('dash-profit');
    if (profitEl) profitEl.innerText = `S/ ${(data.todayProfit || 0).toFixed(2)}`;

    const lowStockEl = document.getElementById('dash-low-stock');
    if (lowStockEl) lowStockEl.innerText = `${data.lowStockCount || 0}`;

    const repCountEl = document.getElementById('topbar-repairs-count');
    if (repCountEl && data.activeRepairsCount !== undefined) {
      repCountEl.innerText = `${data.activeRepairsCount} en Taller`;
    }

    const lowBody = document.getElementById('dash-low-stock-body');
    if (lowBody) {
      const lowList = data.lowStockProducts || [];
      if (lowList.length === 0) {
        lowBody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-emerald-600 font-bold text-xs"><i class="fa-solid fa-circle-check mr-1"></i> Todo el inventario cuenta con stock óptimo sobre el mínimo.</td></tr>`;
      } else {
        lowBody.innerHTML = lowList.map(p => `
          <tr class="hover:bg-rose-50/40 transition-colors">
            <td class="p-3.5 font-mono-code font-bold text-slate-500 text-xs">${p.code}</td>
            <td class="p-3.5 font-bold text-slate-900">${p.name}</td>
            <td class="p-3.5"><span class="bg-slate-100 text-slate-700 px-2.5 py-0.5 rounded-lg text-[11px] font-bold">${p.category}</span></td>
            <td class="p-3.5 text-center"><span class="bg-rose-100 text-rose-700 px-2.5 py-0.5 rounded-lg font-mono-code tabular-nums font-black text-xs">${p.stock} und.</span></td>
            <td class="p-3.5 text-center font-mono-code tabular-nums font-bold text-slate-500 text-xs">${p.min_stock} und.</td>
            <td class="p-3.5 text-right font-mono-code tabular-nums font-black text-indigo-600">S/ ${Number(p.price || 0).toFixed(2)}</td>
          </tr>
        `).join('');
      }
    }
  } catch (err) {
    console.error('Error cargando dashboard:', err);
  }
}

// ==============================================================
// 2. ASISTENTE DE MOSTRADOR (MULTISELECCIÓN FLUIDA)
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

  container.innerHTML = `<div class="text-center py-12 text-slate-500 font-bold text-sm"><i class="fa-solid fa-spinner fa-spin mr-2 text-indigo-600"></i> Consultando ficha de compatibilidades...</div>`;

  try {
    const res = await fetch(`/api/compatibilities/assistant/${modelId}`);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Error al consultar compatibilidad');

    const { model, products } = data;

    const cases = products.filter(p => (p.category || '').toLowerCase().includes('case') || (p.category || '').toLowerCase().includes('funda'));
    const micas = products.filter(p => (p.category || '').toLowerCase().includes('mica') || (p.category || '').toLowerCase().includes('protector'));
    const cargadores = products.filter(p => (p.category || '').toLowerCase().includes('cargador') || (p.category || '').toLowerCase().includes('cable'));
    const otros = products.filter(p => !cases.includes(p) && !micas.includes(p) && !cargadores.includes(p));

    const renderCard = (p) => {
      const isLow = p.stock <= 0;
      const sharedBadges = (p.shared_with && p.shared_with.length > 0) ? `
        <div class="mt-2.5 p-2.5 bg-indigo-50/80 rounded-xl border border-indigo-100">
          <p class="text-[10px] font-black text-indigo-900 leading-tight uppercase tracking-wide">
            <i class="fa-solid fa-share-nodes text-indigo-600 mr-1"></i> También le calza a:
          </p>
          <p class="text-[11px] font-bold text-indigo-700 mt-1 line-clamp-2">${p.shared_with.join(' • ')}</p>
        </div>
      ` : '';

      return `
        <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm hover:border-indigo-300 hover:shadow-md transition-all flex flex-col justify-between">
          <div>
            <div class="flex justify-between items-start mb-1.5">
              <span class="bg-slate-100 text-slate-700 text-[10px] font-bold px-2 py-0.5 rounded-md">${p.category}</span>
              <span class="text-[11px] font-mono-code font-semibold text-slate-400">#${p.code}</span>
            </div>
            <h4 class="font-bold text-[13px] text-slate-900 line-clamp-2 leading-snug">${p.name}</h4>
            ${sharedBadges}
          </div>
          <div class="mt-4 pt-3 border-t border-slate-100 flex justify-between items-center">
            <div>
              <span class="text-[11px] font-mono-code tabular-nums font-bold ${isLow ? 'text-rose-600' : 'text-emerald-700'}">
                Stock: ${p.stock} und.
              </span>
              <p class="text-base font-mono-code tabular-nums font-black text-indigo-600">S/ ${p.price.toFixed(2)}</p>
            </div>
            <button onclick="addToCartFromAssistant(${p.id})" ${isLow ? 'disabled' : ''} class="btn-tactile px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 text-white rounded-xl text-xs font-bold shadow-sm flex items-center gap-1.5 transition-all">
              <i class="fa-solid fa-cart-plus"></i> + Añadir
            </button>
          </div>
        </div>
      `;
    };

    container.innerHTML = `
      <div class="bg-white p-6 rounded-3xl border border-indigo-100 shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <span class="text-[11px] font-black uppercase tracking-wider text-indigo-600">${model.brand_name}</span>
          <h3 class="text-2xl font-black text-slate-900 mt-0.5 flex items-center gap-2 tracking-tight">
            <i class="fa-solid fa-mobile-screen text-indigo-600"></i> ${model.model_name}
          </h3>
          <p class="text-xs text-slate-400 font-medium">Año de lanzamiento: <span class="font-mono-code">${model.release_year || 2024}</span></p>
        </div>
        <div class="flex gap-3">
          <div class="px-4 py-2.5 bg-indigo-50 text-indigo-900 rounded-2xl border border-indigo-100 text-center">
            <p class="text-[10px] uppercase font-bold text-slate-500">Fundas / Cases</p>
            <p class="text-lg font-mono-code tabular-nums font-black text-indigo-700">${cases.length} opciones</p>
          </div>
          <div class="px-4 py-2.5 bg-emerald-50 text-emerald-900 rounded-2xl border border-emerald-100 text-center">
            <p class="text-[10px] uppercase font-bold text-slate-500">Micas / Protectores</p>
            <p class="text-lg font-mono-code tabular-nums font-black text-emerald-700">${micas.length} opciones</p>
          </div>
        </div>
      </div>

      <div class="space-y-3">
        <div class="flex items-center gap-2">
          <div class="w-7 h-7 rounded-lg bg-indigo-600 text-white flex items-center justify-center text-xs"><i class="fa-solid fa-shield-cat"></i></div>
          <h3 class="text-base font-black text-slate-800">1. Fundas, Cases y Protectores Antigolpe (${cases.length})</h3>
        </div>
        ${cases.length === 0 ? `
          <div class="p-6 bg-rose-50 border border-rose-100 text-rose-800 rounded-2xl text-xs font-bold flex items-center gap-2">
            <i class="fa-solid fa-triangle-exclamation text-rose-600 text-base"></i> No hay fundas ni cases registrados en stock para este modelo.
          </div>
        ` : `<div class="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">${cases.map(renderCard).join('')}</div>`}
      </div>

      <div class="space-y-3">
        <div class="flex items-center gap-2">
          <div class="w-7 h-7 rounded-lg bg-emerald-600 text-white flex items-center justify-center text-xs"><i class="fa-solid fa-square"></i></div>
          <h3 class="text-base font-black text-slate-800">2. Micas de Vidrio, Cerámica, Hidrogel & Cámara (${micas.length})</h3>
        </div>
        ${micas.length === 0 ? `
          <div class="p-6 bg-rose-50 border border-rose-100 text-rose-800 rounded-2xl text-xs font-bold flex items-center gap-2">
            <i class="fa-solid fa-triangle-exclamation text-rose-600 text-base"></i> Alerta: 0 micas registradas para este modelo.
          </div>
        ` : `<div class="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">${micas.map(renderCard).join('')}</div>`}
      </div>

      ${(cargadores.length > 0 || otros.length > 0) ? `
        <div class="space-y-3">
          <div class="flex items-center gap-2">
            <div class="w-7 h-7 rounded-lg bg-amber-500 text-white flex items-center justify-center text-xs"><i class="fa-solid fa-bolt"></i></div>
            <h3 class="text-base font-black text-slate-800">3. Cargadores, Cables y Repuestos Compatibles (${cargadores.length + otros.length})</h3>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
            ${[...cargadores, ...otros].map(renderCard).join('')}
          </div>
        </div>
      ` : ''}
    `;

    updateAssistantCartBar();

  } catch (err) {
    container.innerHTML = `<div class="p-6 bg-rose-50 border border-rose-100 text-rose-800 rounded-2xl text-xs font-bold">Error: ${err.message}</div>`;
  }
}

// Agregar producto desde el asistente SIN cambiar de pantalla
function addToCartFromAssistant(productId) {
  const prod = PRODUCTS.find(p => p.id === productId);
  if (!prod) return;

  if (prod.is_serialized === 1) {
    handleProductClick(productId);
    return;
  }

  addToCart(productId);
  showToast('Añadido a la Orden', `${prod.name} (S/ ${prod.price.toFixed(2)})`);
  updateAssistantCartBar();
}

function updateAssistantCartBar() {
  const bar = document.getElementById('assistant-cart-bar');
  const summary = document.getElementById('assistant-cart-summary');
  const totalDisplay = document.getElementById('assistant-cart-total');

  if (!bar) return;

  const count = CART.reduce((sum, i) => sum + i.quantity, 0);
  const { total } = getCartTotals();

  if (count > 0) {
    bar.classList.remove('hidden');
    summary.innerText = `Orden: ${count} producto${count > 1 ? 's' : ''} en carrito`;
    totalDisplay.innerText = `S/ ${total.toFixed(2)}`;
  } else {
    bar.classList.add('hidden');
  }
}

// ==============================================================
// 3. MATRIZ & AUDITORÍA DE COMPATIBILIDAD
// ==============================================================
function switchCompatSubtab(subtab) {
  if (subtab === 'coverage') {
    document.getElementById('subtab-coverage').classList.remove('hidden');
    document.getElementById('subtab-catalog').classList.add('hidden');
    document.getElementById('subtab-btn-coverage').className = 'font-bold text-xs pb-3 border-b-2 border-indigo-600 text-indigo-600';
    document.getElementById('subtab-btn-catalog').className = 'font-bold text-xs pb-3 border-b-2 border-transparent text-slate-400 hover:text-slate-700';
    loadCoverageData();
  } else {
    document.getElementById('subtab-coverage').classList.add('hidden');
    document.getElementById('subtab-catalog').classList.remove('hidden');
    document.getElementById('subtab-btn-coverage').className = 'font-bold text-xs pb-3 border-b-2 border-transparent text-slate-400 hover:text-slate-700';
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
        ? 'btn-tactile px-3 py-1.5 bg-indigo-600 text-white rounded-xl text-xs font-bold' 
        : 'btn-tactile px-3 py-1.5 bg-slate-100 text-slate-700 rounded-xl text-xs font-bold hover:bg-slate-200';
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
    container.innerHTML = `<div class="col-span-full text-center py-12 text-slate-400 font-bold text-xs">No hay modelos que coincidan con el filtro.</div>`;
    return;
  }

  container.innerHTML = filtered.map(m => `
    <div class="bg-white p-5 rounded-3xl border ${m.needsMicas || m.needsCases ? 'border-amber-200 bg-amber-50/20' : 'border-slate-200'} shadow-sm space-y-3">
      <div class="flex justify-between items-start">
        <div>
          <span class="text-[10px] font-black uppercase text-indigo-600">${m.brand_name}</span>
          <h4 class="font-black text-sm text-slate-900">${m.model_name}</h4>
          <p class="text-[10px] font-mono-code text-slate-400">Año ${m.release_year}</p>
        </div>
        <button onclick="switchTab('assistant'); document.getElementById('assistant-brand-select').value='${m.brand_id}'; onAssistantBrandChange(); document.getElementById('assistant-model-select').value='${m.id}'; loadAssistantModelData(${m.id});" class="btn-tactile text-indigo-600 hover:text-indigo-800 text-xs font-bold bg-indigo-50 px-2.5 py-1.5 rounded-xl">
          Ver 360° <i class="fa-solid fa-arrow-right ml-1"></i>
        </button>
      </div>

      <div class="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100">
        <div class="p-2.5 rounded-2xl ${m.needsCases ? 'bg-rose-50 text-rose-800 border border-rose-100' : 'bg-slate-50 text-slate-700'}">
          <p class="text-[9px] uppercase font-bold text-slate-400">Cases / Fundas</p>
          <p class="text-xs font-mono-code tabular-nums font-black ${m.needsCases ? 'text-rose-600' : 'text-slate-900'}">${m.casesStock} en stock (${m.casesCount} tipos)</p>
          ${m.needsCases ? '<span class="text-[9px] font-bold text-rose-600 uppercase">⚠️ Desabastecido</span>' : ''}
        </div>
        <div class="p-2.5 rounded-2xl ${m.needsMicas ? 'bg-rose-50 text-rose-800 border border-rose-100' : 'bg-slate-50 text-slate-700'}">
          <p class="text-[9px] uppercase font-bold text-slate-400">Micas / Vidrios</p>
          <p class="text-xs font-mono-code tabular-nums font-black ${m.needsMicas ? 'text-rose-600' : 'text-slate-900'}">${m.micasStock} en stock (${m.micasCount} tipos)</p>
          ${m.needsMicas ? '<span class="text-[9px] font-bold text-rose-600 uppercase">⚠️ Desabastecido</span>' : ''}
        </div>
      </div>
    </div>
  `).join('');
}

function renderCompatibilityMatrix() {
  const container = document.getElementById('subtab-catalog');
  if (!container) return;

  if (BRANDS.length === 0) {
    container.innerHTML = `<div class="col-span-full text-center py-12 text-slate-400 font-bold">No hay marcas ni modelos registrados.</div>`;
    return;
  }

  container.innerHTML = BRANDS.map(b => `
    <div class="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm space-y-3">
      <div class="flex justify-between items-center pb-2 border-b border-slate-100">
        <h3 class="font-black text-indigo-900 text-sm flex items-center gap-2">
          <i class="fa-solid fa-mobile-screen text-indigo-600"></i> ${b.name}
        </h3>
        <span class="bg-indigo-50 text-indigo-700 font-mono-code tabular-nums text-xs font-bold px-2.5 py-0.5 rounded-full">${b.models.length} Modelos</span>
      </div>
      <div class="divide-y divide-slate-100 max-h-56 overflow-y-auto custom-scrollbar">
        ${b.models.map(m => `
          <div class="py-2 flex justify-between items-center text-[13px]">
            <span class="font-bold text-slate-800"><i class="fa-solid fa-angle-right text-indigo-400 mr-1.5"></i>${m.model_name}</span>
            <div class="flex items-center gap-2">
              <span class="font-mono-code text-slate-400 text-[11px]">${m.release_year || 2024}</span>
              <button onclick="deleteModel(${m.id})" class="action-icon-btn bg-rose-50 text-rose-500 hover:bg-rose-100 hover:text-rose-700" title="Eliminar Modelo"><i class="fa-solid fa-trash text-xs"></i></button>
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

    showToast('Vínculos Guardados', data.message);
    closeBulkCompatModal();
    await loadProducts();
    await loadCoverageData();
  } catch (err) {
    alert('❌ Error: ' + err.message);
  }
}

// MARCAS Y MODELOS
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

let currentPosCategoryFilter = 'all';

function filterCategory(catKey, btn) {
  currentPosCategoryFilter = catKey;
  document.querySelectorAll('.category-pill').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderProducts();
}

function clearModelFilters() {
  const brandFilter = document.getElementById('pos-brand-filter');
  const modelFilter = document.getElementById('pos-model-filter');
  const searchInput = document.getElementById('search-input');

  if (brandFilter) brandFilter.value = '';
  if (modelFilter) modelFilter.innerHTML = '<option value="">-- Todos los Modelos --</option>';
  if (searchInput) searchInput.value = '';
  currentPosCategoryFilter = 'all';

  document.querySelectorAll('.category-pill').forEach(b => b.classList.remove('active'));
  const allPill = document.querySelector('.category-pill');
  if (allPill) allPill.classList.add('active');

  renderProducts();
}

function renderProducts() {
  const modelFilterEl = document.getElementById('pos-model-filter');
  const searchInputEl = document.getElementById('search-input');
  const grid = document.getElementById('product-grid');
  if (!grid) return;

  const selectedModelId = modelFilterEl ? modelFilterEl.value : '';
  const query = (searchInputEl?.value || '').toLowerCase().trim();

  const filtered = PRODUCTS.filter(p => {
    let matchCat = true;
    if (currentPosCategoryFilter && currentPosCategoryFilter !== 'all') {
      const pCat = (p.category || '').toLowerCase();
      matchCat = pCat.includes(currentPosCategoryFilter.toLowerCase());
    }
    let matchModel = true;
    if (selectedModelId) {
      matchModel = p.compatible_models && p.compatible_models.some(m => String(m.model_id) === String(selectedModelId));
    }
    const matchQuery = p.name.toLowerCase().includes(query) || p.code.toLowerCase().includes(query) || (p.category || '').toLowerCase().includes(query);
    return matchCat && matchModel && matchQuery;
  });

  const countBadge = document.getElementById('pos-items-count');
  if (countBadge) countBadge.innerText = filtered.length;

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="col-span-full text-center py-12 text-slate-400 space-y-2">
        <div class="w-12 h-12 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center text-xl mx-auto">
          <i class="fa-solid fa-boxes-stacked"></i>
        </div>
        <p class="font-bold text-xs text-slate-600">No se encontraron productos en esta categoría o filtro</p>
        <p class="text-[11px] text-slate-400">Intenta seleccionar otra categoría o limpiar la búsqueda.</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = filtered.map(p => {
    const isSerialized = p.is_serialized === 1;
    const isLowStock = p.stock <= (p.min_stock || 5);
    const modelBadges = (p.compatible_models || []).slice(0, 2).map(m => `
      <span class="bg-indigo-50 text-indigo-700 text-[9px] font-bold px-1.5 py-0.5 rounded border border-indigo-100 truncate">${m.model_name}</span>
    `).join('');

    return `
      <div onclick="handleProductClick(${p.id})" class="bg-white p-3.5 sm:p-4 rounded-3xl border border-slate-200/90 shadow-2xs hover:border-indigo-400 hover:shadow-md transition-all cursor-pointer flex flex-col justify-between group select-none">
        <div>
          <div class="flex justify-between items-start gap-1 mb-1.5">
            <span class="bg-slate-100 text-slate-600 text-[10px] font-bold px-2 py-0.5 rounded-lg truncate max-w-[110px]">${p.category || 'General'}</span>
            ${isSerialized ? '<span class="bg-amber-100 text-amber-800 text-[9px] font-mono-code font-extrabold px-1.5 py-0.5 rounded">IMEI</span>' : `<span class="text-[10px] font-mono-code text-slate-400 font-bold">#${p.code}</span>`}
          </div>
          <h3 class="font-bold text-slate-900 text-xs sm:text-[13px] group-hover:text-indigo-600 transition-colors line-clamp-2 leading-snug">${p.name}</h3>
          <div class="mt-2 flex flex-wrap gap-1">${modelBadges}</div>
        </div>
        <div class="mt-3.5 flex justify-between items-end pt-2.5 border-t border-slate-100">
          <div>
            <span class="text-[10px] font-mono-code font-bold ${isLowStock ? 'text-rose-600 bg-rose-50 px-1.5 py-0.5 rounded' : 'text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded'}">
              ${isLowStock ? `Stock: ${p.stock} (Bajo)` : `Stock: ${p.stock}`}
            </span>
            <p class="text-sm sm:text-base font-mono-code tabular-nums font-black text-slate-900 mt-0.5">S/ ${p.price.toFixed(2)}</p>
          </div>
          <button class="w-8 h-8 rounded-xl bg-indigo-50 text-indigo-600 group-hover:bg-indigo-600 group-hover:text-white flex items-center justify-center text-xs font-bold transition-all shadow-2xs">
            <i class="fa-solid fa-plus"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function handleProductClick(productId) {
  const prod = PRODUCTS.find(p => p.id === productId);
  if (!prod || prod.stock <= 0) {
    showToast('Sin Stock', 'Este producto no cuenta con existencias disponibles.', 'warning');
    return;
  }

  // Si requiere IMEI
  if (prod.is_serialized === 1) {
    pendingImeiProduct = prod;
    document.getElementById('modal-imei-prod-name').innerText = `${prod.name} (#${prod.code})`;
    const listContainer = document.getElementById('modal-imei-list');
    listContainer.innerHTML = '<p class="text-xs text-slate-400">Consultando IMEIs disponibles...</p>';
    document.getElementById('modal-select-imei').classList.remove('hidden');

    try {
      const res = await fetch(`/api/imeis/available/${productId}`);
      const imeis = await res.json();
      if (imeis.length === 0) {
        listContainer.innerHTML = '<p class="text-xs text-rose-500 font-bold">⚠️ No hay códigos IMEI disponibles para este equipo.</p>';
        return;
      }
      listContainer.innerHTML = imeis.map(i => `
        <div onclick="selectImeiForSale('${i.imei_code}')" class="p-2.5 bg-slate-50 hover:bg-indigo-50 rounded-xl border border-slate-200 hover:border-indigo-300 cursor-pointer flex justify-between items-center transition-all">
          <span class="font-mono-code text-xs font-black text-slate-800">${i.imei_code}</span>
          <span class="text-[10px] font-bold text-indigo-600 bg-indigo-100 px-2.5 py-0.5 rounded-lg">Asignar</span>
        </div>
      `).join('');
    } catch (e) {
      listContainer.innerHTML = '<p class="text-xs text-rose-500">Error al cargar IMEIs</p>';
    }
  } else {
    addToCart(productId);
    showToast('Añadido', `${prod.name}`);
  }
}

function selectImeiForSale(imeiCode) {
  if (!pendingImeiProduct) return;

  const alreadyInCart = CART.find(i => i.imei === imeiCode);
  if (alreadyInCart) {
    alert('⚠️ Este IMEI ya está agregado en la orden actual.');
    return;
  }

  CART.push({
    product: pendingImeiProduct,
    quantity: 1,
    imei: imeiCode
  });

  closeImeiSelectModal();
  renderCart();
  updateAssistantCartBar();
  showToast('Equipo Añadido', `IMEI: ${imeiCode}`);
}

function closeImeiSelectModal() {
  document.getElementById('modal-select-imei').classList.add('hidden');
  pendingImeiProduct = null;
}

function addToCart(productId) {
  const prod = PRODUCTS.find(p => p.id === productId);
  if (!prod || prod.stock <= 0) {
    showToast('Sin Stock', 'No hay stock disponible.', 'warning');
    return;
  }

  const existing = CART.find(i => i.product.id === productId && !i.imei);
  if (existing) {
    if (existing.quantity >= prod.stock) {
      showToast('Stock Máximo', `Solo hay ${prod.stock} unidades en almacén.`, 'warning');
      return;
    }
    existing.quantity += 1;
  } else {
    CART.push({ product: prod, quantity: 1, imei: '' });
  }

  renderCart();
  updateAssistantCartBar();
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
  updateAssistantCartBar();
}

function getCartTotals() {
  const grossTotal = CART.reduce((sum, i) => sum + (i.product.price * i.quantity), 0);
  const discountInput = document.getElementById('cart-discount');
  const rawDiscount = parseFloat(discountInput?.value) || 0;
  const discount = Math.min(Math.max(0, rawDiscount), grossTotal);
  const total = Math.max(0, grossTotal - discount);
  const subtotal = total / 1.18;
  const tax = total - subtotal;
  return { grossTotal, discount, total, subtotal, tax };
}

function clearCart() {
  CART = [];
  const discountInput = document.getElementById('cart-discount');
  if (discountInput) discountInput.value = '0.00';
  renderCart();
  updateAssistantCartBar();
}

function renderCart() {
  const container = document.getElementById('cart-items');
  const payBtn = document.getElementById('btn-pay');

  if (CART.length === 0) {
    if (container) {
      container.innerHTML = `
        <div class="py-12 px-4 text-center text-slate-400 space-y-2">
          <div class="w-12 h-12 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center text-xl mx-auto shadow-2xs">
            <i class="fa-solid fa-receipt"></i>
          </div>
          <p class="font-extrabold text-xs text-slate-700">Ticket Vacío</p>
          <p class="text-[11px] text-slate-400 max-w-xs mx-auto">Selecciona productos a la izquierda o pistolea códigos de barra para agregarlos al ticket.</p>
        </div>
      `;
    }
    const subtotalEl = document.getElementById('summary-subtotal');
    const taxEl = document.getElementById('summary-tax');
    const totalEl = document.getElementById('summary-total');
    if (subtotalEl) subtotalEl.innerText = 'S/ 0.00';
    if (taxEl) taxEl.innerText = 'S/ 0.00';
    if (totalEl) totalEl.innerText = 'S/ 0.00';
    if (payBtn) {
      payBtn.disabled = true;
      payBtn.innerHTML = '<i class="fa-solid fa-cash-register text-sm"></i><span>COBRAR TICKET (F4)</span>';
    }
    updateAssistantCartBar();
    return;
  }

  container.innerHTML = CART.map(i => {
    const itemSub = i.product.price * i.quantity;
    const imeiTag = i.imei ? `<p class="text-[9px] font-mono-code font-bold text-amber-800 bg-amber-50 px-1.5 py-0.2 rounded inline-block mt-0.5 border border-amber-200">IMEI: ${i.imei}</p>` : '';

    return `
      <div class="p-2.5 rounded-2xl bg-white hover:bg-slate-50 transition-colors flex justify-between items-center gap-2 border border-slate-100 shadow-2xs">
        <div class="flex-1 min-w-0 pr-1">
          <p class="font-bold text-xs text-slate-800 truncate leading-snug">${i.product.name}</p>
          ${imeiTag}
          <p class="text-[10px] font-mono-code tabular-nums text-slate-400 font-semibold mt-0.5">S/ ${i.product.price.toFixed(2)} c/u</p>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          ${!i.imei ? `
            <button onclick="updateCartQty(${i.product.id}, -1)" class="w-6 h-6 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-bold transition-colors flex items-center justify-center">-</button>
            <span class="text-xs font-mono-code tabular-nums font-bold w-5 text-center">${i.quantity}</span>
            <button onclick="updateCartQty(${i.product.id}, 1)" class="w-6 h-6 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-bold transition-colors flex items-center justify-center">+</button>
          ` : `
            <button onclick="updateCartQty(${i.product.id}, -1, '${i.imei}')" class="w-6 h-6 bg-rose-50 text-rose-500 hover:bg-rose-100 hover:text-rose-700 rounded-lg text-xs flex items-center justify-center transition-colors" title="Quitar IMEI"><i class="fa-solid fa-trash text-xs"></i></button>
          `}
        </div>
        <span class="font-mono-code tabular-nums font-black text-xs text-slate-900 w-16 text-right shrink-0">S/ ${itemSub.toFixed(2)}</span>
      </div>
    `;
  }).join('');

  const { subtotal, tax, total } = getCartTotals();
  const subtotalEl = document.getElementById('summary-subtotal');
  const taxEl = document.getElementById('summary-tax');
  const totalEl = document.getElementById('summary-total');
  if (subtotalEl) subtotalEl.innerText = `S/ ${subtotal.toFixed(2)}`;
  if (taxEl) taxEl.innerText = `S/ ${tax.toFixed(2)}`;
  if (totalEl) totalEl.innerText = `S/ ${total.toFixed(2)}`;
  if (payBtn) {
    payBtn.disabled = false;
    payBtn.innerHTML = `<i class="fa-solid fa-cash-register text-sm"></i><span>COBRAR S/ ${total.toFixed(2)} (F4)</span>`;
  }
  updateAssistantCartBar();
}

// ==============================================================
// 5. MODAL DE PAGO, PAGOS MIXTOS & EMISIÓN DE TICKET
// ==============================================================
function populateCustomerDropdown() {
  const select = document.getElementById('modal-select-customer');
  if (select) {
    const prevVal = select.value;
    select.innerHTML = '<option value="">Público General</option>' + 
      CLIENTS.map(c => `<option value="${c.id}">${c.name} (${c.doc}) ${c.debt > 0 ? '- Deuda: S/ ' + parseFloat(c.debt).toFixed(2) : ''}</option>`).join('');
    if (prevVal) select.value = prevVal;
  }
}

function openPaymentModal() {
  if (!isCashRegisterOpen) {
    openRequireCashModal();
    return;
  }

  const { total } = getCartTotals();
  document.getElementById('modal-pay-total').innerText = `S/ ${total.toFixed(2)}`;
  document.getElementById('tendered-amount').value = total.toFixed(2);
  
  setPaymentMethod('Efectivo');
  calculateChange();
  document.getElementById('modal-payment').classList.remove('hidden');
}

function closePaymentModal() {
  document.getElementById('modal-payment').classList.add('hidden');
}

function setPaymentMethod(method) {
  selectedPaymentMethod = method;
  document.querySelectorAll('.pay-btn').forEach(b => {
    b.className = 'pay-btn btn-tactile bg-slate-100 text-slate-700 font-bold py-2.5 rounded-xl text-xs';
  });
  const activeBtn = document.getElementById('pay-' + method);
  if (activeBtn) activeBtn.className = 'pay-btn active btn-tactile bg-indigo-600 text-white font-bold py-2.5 rounded-xl text-xs shadow-sm';

  const cashBox = document.getElementById('cash-calculator-box');
  const mixedBox = document.getElementById('mixed-payment-box');

  if (method === 'Efectivo') {
    cashBox.classList.remove('hidden');
    mixedBox.classList.add('hidden');
  } else if (method === 'Mixto') {
    cashBox.classList.add('hidden');
    mixedBox.classList.remove('hidden');
    
    // Inicializar desglose mixto con el total dividido por defecto
    const { total } = getCartTotals();
    document.getElementById('mix-efectivo').value = (total / 2).toFixed(2);
    document.getElementById('mix-yape').value = (total / 2).toFixed(2);
    document.getElementById('mix-tarjeta').value = '0.00';
    calculateMixedPayment();
  } else {
    cashBox.classList.add('hidden');
    mixedBox.classList.add('hidden');
  }
}

function calculateChange() {
  const { total } = getCartTotals();
  const tendered = parseFloat(document.getElementById('tendered-amount').value) || 0;
  const change = Math.max(0, tendered - total);
  document.getElementById('change-amount-display').innerText = `S/ ${change.toFixed(2)}`;
}

function calculateMixedPayment() {
  const { total } = getCartTotals();
  const ef = parseFloat(document.getElementById('mix-efectivo').value) || 0;
  const yp = parseFloat(document.getElementById('mix-yape').value) || 0;
  const tj = parseFloat(document.getElementById('mix-tarjeta').value) || 0;

  const covered = ef + yp + tj;
  const pending = total - covered;

  document.getElementById('mixed-covered-label').innerText = `Cubierto: S/ ${covered.toFixed(2)}`;
  if (pending <= 0.01) {
    document.getElementById('mixed-pending-label').className = 'font-mono-code tabular-nums text-emerald-700 font-black';
    document.getElementById('mixed-pending-label').innerText = '✅ Monto Cubierto Total';
  } else {
    document.getElementById('mixed-pending-label').className = 'font-mono-code tabular-nums text-rose-600 font-black';
    document.getElementById('mixed-pending-label').innerText = `Falta: S/ ${pending.toFixed(2)}`;
  }
}

async function processFinalSale() {
  if (!isCashRegisterOpen) {
    openRequireCashModal();
    return;
  }

  const customerId = document.getElementById('modal-select-customer').value;
  const customerObj = CLIENTS.find(c => String(c.id) === String(customerId));
  const customerName = customerObj ? customerObj.name : 'Público General';
  const docType = document.getElementById('modal-doc-type').value;

  if (selectedPaymentMethod === 'Crédito' && !customerId) {
    alert('⚠️ Para registrar una venta al CRÉDITO, debe seleccionar un cliente registrado.');
    return;
  }

  const { total, discount } = getCartTotals();
  let paymentDetails = null;
  let tendered = total;
  let change = 0;

  if (selectedPaymentMethod === 'Efectivo') {
    tendered = parseFloat(document.getElementById('tendered-amount').value) || total;
    change = Math.max(0, tendered - total);
  } else if (selectedPaymentMethod === 'Mixto') {
    const ef = parseFloat(document.getElementById('mix-efectivo').value) || 0;
    const yp = parseFloat(document.getElementById('mix-yape').value) || 0;
    const tj = parseFloat(document.getElementById('mix-tarjeta').value) || 0;
    const covered = ef + yp + tj;

    if (Math.abs(covered - total) > 0.05 && covered < total) {
      alert(`⚠️ En pago mixto, la suma de los montos (S/ ${covered.toFixed(2)}) debe cubrir el total de la venta (S/ ${total.toFixed(2)}).`);
      return;
    }

    paymentDetails = { efectivo: ef, yape: yp, tarjeta: tj };
    tendered = covered;
    change = 0;
  }

  const payload = {
    doc_type: docType,
    customer_id: customerId ? parseInt(customerId) : null,
    customer_name: customerName,
    payment_method: selectedPaymentMethod,
    payment_details: paymentDetails,
    paid_amount: tendered,
    change_amount: change,
    discount: discount,
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
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.cash_closed) {
        openRequireCashModal();
        return;
      }
      throw new Error(data.error || 'Error al emitir venta');
    }

    closePaymentModal();
    clearCart();
    await loadProducts();
    await loadCustomers();
    await loadDashboard();
    await loadCashStatus();

    showToast('Venta Exitosa', `Comprobante ${data.sale.receipt_code} generado.`);

    // Renderizar Ticket Térmico Unificado
    renderThermalTicket(data.sale);
    document.getElementById('modal-ticket').classList.remove('hidden');

  } catch (err) {
    alert('❌ Error: ' + err.message);
  }
}

// Renderizado de Ticket Térmico (Tipografía y grosor unificado para ticketeras)
function renderThermalTicket(sale) {
  const container = document.getElementById('thermal-ticket-container');
  if (!container) return;

  const dateStr = new Date(sale.created_at || Date.now()).toLocaleString();
  const itemsHtml = (sale.items || []).map(i => `
    <div style="border-bottom: 1px dashed #666; padding: 4px 0;">
      <div style="display: flex; justify-content: space-between;">
        <span>${i.quantity}x ${i.product_name}</span>
        <span>S/ ${(i.quantity * i.unit_price).toFixed(2)}</span>
      </div>
      ${i.imei_code ? `<div style="font-weight: bold; margin-top: 2px;">IMEI: ${i.imei_code}</div>` : ''}
    </div>
  `).join('');

  let paymentText = sale.payment_method;
  if (sale.payment_method === 'Mixto' && sale.payment_details) {
    const d = sale.payment_details;
    const parts = [];
    if (d.efectivo > 0) parts.push(`Efec: S/ ${parseFloat(d.efectivo).toFixed(2)}`);
    if (d.yape > 0) parts.push(`Yape: S/ ${parseFloat(d.yape).toFixed(2)}`);
    if (d.tarjeta > 0) parts.push(`Tarj: S/ ${parseFloat(d.tarjeta).toFixed(2)}`);
    paymentText = `Mixto (${parts.join(', ')})`;
  }

  const discountVal = parseFloat(sale.discount || 0);

  container.innerHTML = `
    <div style="text-align: center; border-bottom: 1px dashed #666; padding-bottom: 6px; margin-bottom: 6px;">
      <div style="font-size: 14px; font-weight: bold;">CELLVENTAS</div>
      <div>ACCESORIOS Y CELULARES</div>
      <div>VT VALETEC</div>
      <div style="margin-top: 4px; font-weight: bold;">${(sale.doc_type || 'TICKET').toUpperCase()}: ${sale.receipt_code}</div>
      <div style="font-size: 11px;">${dateStr}</div>
    </div>

    <div style="border-bottom: 1px dashed #666; padding-bottom: 4px; margin-bottom: 4px;">
      <div>CLIENTE: ${sale.customer_name}</div>
      <div>PAGO: ${paymentText}</div>
    </div>

    <div>
      ${itemsHtml}
    </div>

    <div style="border-top: 1px dashed #666; padding-top: 6px; margin-top: 6px;">
      ${discountVal > 0 ? `
        <div style="display: flex; justify-content: space-between;">
          <span>Descuento:</span>
          <span>- S/ ${discountVal.toFixed(2)}</span>
        </div>
      ` : ''}
      <div style="display: flex; justify-content: space-between;">
        <span>Subtotal:</span>
        <span>S/ ${parseFloat(sale.subtotal).toFixed(2)}</span>
      </div>
      <div style="display: flex; justify-content: space-between;">
        <span>IGV (18%):</span>
        <span>S/ ${parseFloat(sale.tax).toFixed(2)}</span>
      </div>
      <div style="display: flex; justify-content: space-between; font-size: 14px; font-weight: bold; border-top: 1px solid #000; padding-top: 4px; margin-top: 4px;">
        <span>TOTAL:</span>
        <span>S/ ${parseFloat(sale.total).toFixed(2)}</span>
      </div>
      ${sale.payment_method === 'Efectivo' ? `
        <div style="display: flex; justify-content: space-between; margin-top: 2px;">
          <span>Recibido:</span>
          <span>S/ ${parseFloat(sale.paid_amount || sale.total).toFixed(2)}</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span>Vuelto:</span>
          <span>S/ ${parseFloat(sale.change_amount || 0).toFixed(2)}</span>
        </div>
      ` : ''}
    </div>

    <div style="text-align: center; margin-top: 10px; border-top: 1px dashed #666; padding-top: 6px; font-size: 11px;">
      <div>¡Gracias por su compra!</div>
      <div>Conserve este comprobante para su garantía.</div>
    </div>
  `;
}

function closeTicketModal() {
  document.getElementById('modal-ticket').classList.add('hidden');
}

// ==============================================================
// 6. HISTORIAL DE VENTAS & ANULACIONES (CON REVERSIÓN EN CAJA)
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

function setSalesDatePreset(preset) {
  const fromInput = document.getElementById('sales-filter-from');
  const toInput = document.getElementById('sales-filter-to');
  if (!fromInput || !toInput) return;

  const now = new Date();
  const formatYMD = (d) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  if (preset === 'today') {
    const todayStr = formatYMD(now);
    fromInput.value = todayStr;
    toInput.value = todayStr;
  } else if (preset === 'week') {
    const startOfWeek = new Date(now);
    const day = startOfWeek.getDay();
    const diff = (day === 0 ? -6 : 1) - day;
    startOfWeek.setDate(startOfWeek.getDate() + diff);
    fromInput.value = formatYMD(startOfWeek);
    toInput.value = formatYMD(now);
  } else if (preset === 'month') {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    fromInput.value = formatYMD(startOfMonth);
    toInput.value = formatYMD(now);
  } else if (preset === 'all') {
    fromInput.value = '';
    toInput.value = '';
  }

  renderSalesHistoryTable();
}

function getFilteredSales() {
  const query = (document.getElementById('sales-search')?.value || '').toLowerCase().trim();
  const fromDate = document.getElementById('sales-filter-from')?.value;
  const toDate = document.getElementById('sales-filter-to')?.value;

  return SALES.filter(s => {
    const matchesText = !query || 
      s.receipt_code.toLowerCase().includes(query) || 
      (s.customer_name || '').toLowerCase().includes(query) ||
      s.payment_method.toLowerCase().includes(query);
    if (!matchesText) return false;

    if (fromDate || toDate) {
      const saleDate = new Date(s.created_at);
      if (fromDate) {
        const from = new Date(fromDate + 'T00:00:00');
        if (saleDate < from) return false;
      }
      if (toDate) {
        const to = new Date(toDate + 'T23:59:59');
        if (saleDate > to) return false;
      }
    }
    return true;
  });
}

function renderSalesHistoryTable() {
  const tbody = document.getElementById('sales-table-body');
  if (!tbody) return;

  const filtered = getFilteredSales();

  const countEl = document.getElementById('sales-filter-count');
  const sumEl = document.getElementById('sales-filter-sum');
  const totalActivas = filtered
    .filter(s => s.status !== 'anulada')
    .reduce((acc, curr) => acc + (parseFloat(curr.total) || 0), 0);

  if (countEl) countEl.innerText = `${filtered.length} venta(s) encontrada(s)`;
  if (sumEl) sumEl.innerText = `Total activo: S/ ${totalActivas.toFixed(2)}`;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="p-8 text-center text-slate-400 font-bold">No hay comprobantes de venta que coincidan con los filtros.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(s => {
    const isAnulada = s.status === 'anulada';
    const itemsPreview = (s.items || []).map(i => `<span class="font-mono-code font-bold text-slate-500">${i.quantity}x</span> ${i.product_name} ${i.imei_code ? '<span class="font-mono-code text-[10px] bg-amber-50 text-amber-800 px-1.5 py-0.5 rounded">(IMEI: ' + i.imei_code + ')</span>' : ''}`).join('<br>');

    let payLabel = s.payment_method;
    if (s.payment_method === 'Mixto' && s.payment_details) {
      payLabel = `Mixto (Ef: S/ ${s.payment_details.efectivo || 0}, Dig: S/ ${(s.payment_details.yape || 0) + (s.payment_details.tarjeta || 0)})`;
    }

    return `
      <tr class="hover:bg-slate-50/80 transition-colors ${isAnulada ? 'opacity-40 line-through' : ''}">
        <td class="p-4 font-mono-code font-bold text-slate-800 text-xs">${s.receipt_code}</td>
        <td class="p-4 text-slate-500 text-xs">${new Date(s.created_at).toLocaleString()}</td>
        <td class="p-4 font-bold text-slate-800">${s.customer_name}</td>
        <td class="p-4"><span class="bg-slate-100 text-slate-700 px-2.5 py-0.5 rounded-lg text-[11px] font-bold">${payLabel}</span></td>
        <td class="p-4 text-xs text-slate-600">${itemsPreview}</td>
        <td class="p-4 text-right font-mono-code tabular-nums font-black text-slate-900">S/ ${parseFloat(s.total).toFixed(2)}</td>
        <td class="p-4 text-center">
          <span class="px-2.5 py-1 rounded-full text-[10px] font-black ${isAnulada ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'}">
            ${s.status.toUpperCase()}
          </span>
        </td>
        <td class="p-4 text-center">
          <div class="flex items-center justify-center gap-2">
            <button onclick="reprintTicket(${s.id})" class="action-icon-btn bg-indigo-50 text-indigo-600 hover:bg-indigo-100 hover:text-indigo-800" title="Ver / Imprimir Ticket"><i class="fa-solid fa-print text-xs"></i></button>
            ${!isAnulada ? `
              <button onclick="anularSale(${s.id}, '${s.receipt_code}')" class="action-icon-btn bg-rose-50 text-rose-600 hover:bg-rose-100 hover:text-rose-800" title="Anular Venta"><i class="fa-solid fa-ban text-xs"></i></button>
            ` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function exportSalesToCSV() {
  const filtered = getFilteredSales();

  if (filtered.length === 0) {
    alert('No hay ventas para exportar con los filtros seleccionados.');
    return;
  }

  const headers = [
    'Comprobante',
    'Tipo Doc',
    'Fecha y Hora',
    'Cliente',
    'Metodo de Pago',
    'Detalle Items',
    'Subtotal (S/)',
    'IGV (S/)',
    'Descuento (S/)',
    'Total (S/)',
    'Estado',
    'Usuario / Cajero'
  ];

  const escapeCSV = (val) => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const rows = filtered.map(s => {
    const itemsText = (s.items || [])
      .map(i => `${i.quantity}x ${i.product_name}${i.imei_code ? ' [IMEI: ' + i.imei_code + ']' : ''}`)
      .join('; ');

    const dateFormatted = new Date(s.created_at).toLocaleString('es-PE', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    return [
      escapeCSV(s.receipt_code),
      escapeCSV(s.doc_type || 'Ticket'),
      escapeCSV(dateFormatted),
      escapeCSV(s.customer_name || 'Público General'),
      escapeCSV(s.payment_method),
      escapeCSV(itemsText),
      escapeCSV(parseFloat(s.subtotal || 0).toFixed(2)),
      escapeCSV(parseFloat(s.tax || 0).toFixed(2)),
      escapeCSV(parseFloat(s.discount || 0).toFixed(2)),
      escapeCSV(parseFloat(s.total || 0).toFixed(2)),
      escapeCSV(s.status === 'anulada' ? 'ANULADA' : 'EMITIDA'),
      escapeCSV(s.user_name || 'Administrador')
    ].join(';');
  });

  const csvContent = '\uFEFF' + headers.map(h => escapeCSV(h)).join(';') + '\r\n' + rows.join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateStr = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `reporte_ventas_cellventas_${dateStr}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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
  if (!confirm(`¿Está seguro de ANULAR la venta #${code}?\n\n- Se restituirá el stock al almacén.\n- Se liberarán los códigos IMEI correspondientes.\n- El monto se descontará del arqueo de caja actual.\n- Si fue al crédito, se descontará la deuda.`)) return;

  try {
    const res = await fetch(`/api/sales/${saleId}/anular`, { method: 'PUT', headers: getAuthHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al anular venta');

    showToast('Venta Anulada', `Venta #${code} anulada. Stock y caja actualizados.`);
    await loadSalesHistory();
    await loadProducts();
    await loadCustomers();
    await loadDashboard();
    await loadCashStatus();
  } catch (err) {
    alert('❌ Error: ' + err.message);
  }
}

// ==============================================================
// 7. RASTREADOR DE IMEIS
// ==============================================================
async function searchImeiTracker() {
  const query = (document.getElementById('imei-tracker-input')?.value || '').trim();
  const container = document.getElementById('imei-tracker-results');
  if (!container) return;

  if (!query) {
    container.innerHTML = '<div class="text-center py-8 text-slate-400 font-medium text-xs">Escriba un código IMEI (ej. 8642...) para ver su trazabilidad.</div>';
    return;
  }

  container.innerHTML = '<div class="text-center py-6 text-slate-400 text-xs font-bold"><i class="fa-solid fa-spinner fa-spin mr-2 text-indigo-600"></i> Buscando IMEI...</div>';

  try {
    const res = await fetch(`/api/imeis/search/${query}`);
    const results = await res.json();

    if (results.length === 0) {
      container.innerHTML = '<div class="text-center py-8 text-rose-500 font-bold text-xs">⚠️ No se encontró ningún teléfono registrado con ese código IMEI.</div>';
      return;
    }

    container.innerHTML = results.map(i => {
      const isVendido = i.status === 'vendido';
      return `
        <div class="bg-slate-50 p-4 rounded-2xl border border-slate-200 flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
          <div>
            <div class="flex items-center gap-2">
              <span class="font-mono-code font-black text-sm text-slate-900">${i.imei_code}</span>
              <span class="px-2.5 py-0.5 rounded-lg text-[10px] font-black ${isVendido ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}">
                ${i.status.toUpperCase()}
              </span>
            </div>
            <p class="text-[13px] font-bold text-slate-700 mt-1">${i.product_name} <span class="text-slate-400 font-mono-code text-xs">(#${i.product_code})</span></p>
          </div>
          <div class="text-xs text-slate-500 space-y-0.5 md:text-right">
            ${isVendido ? `
              <p><span class="font-bold text-slate-700">Comprobante:</span> <span class="font-mono-code font-bold text-indigo-600">${i.receipt_code}</span></p>
              <p><span class="font-bold text-slate-700">Cliente:</span> ${i.customer_name}</p>
              <p><span class="font-bold text-slate-700">Fecha Venta:</span> ${new Date(i.sold_at || i.sale_date).toLocaleString()}</p>
            ` : `
              <p class="text-emerald-700 font-bold"><i class="fa-solid fa-check mr-1"></i> Disponible en vitrina / stock</p>
              <p class="text-[11px] text-slate-400">Ingresado: ${new Date(i.created_at).toLocaleDateString()}</p>
            `}
          </div>
        </div>
      `;
    }).join('');

  } catch (err) {
    container.innerHTML = `<div class="p-4 bg-rose-50 text-rose-700 rounded-xl text-xs font-bold">Error: ${err.message}</div>`;
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
      headers: getAuthHeaders(),
      body: JSON.stringify({ product_id, imeis })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al guardar IMEIs');

    showToast('IMEIs Registrados', `${data.insertedCount} códigos IMEI agregados.`);
    closeImeiEntryModal();
    document.getElementById('imei-entry-codes').value = '';
    await loadProducts();
    if (document.getElementById('imei-tracker-input').value) searchImeiTracker();
  } catch (err) {
    alert('❌ Error: ' + err.message);
  }
}

// ==============================================================
// 8. CONTROL DE CAJA, ARQUEO Z & TABLA DE MOVIMIENTOS
// ==============================================================
function openRequireCashModal() {
  document.getElementById('modal-require-cash').classList.remove('hidden');
}

function closeRequireCashModal() {
  document.getElementById('modal-require-cash').classList.add('hidden');
}

async function submitFastOpenCash() {
  const amount = parseFloat(document.getElementById('modal-fast-cash-amount').value) || 0;
  try {
    const res = await fetch('/api/cash/open', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ initial_amount: amount })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al abrir caja');

    closeRequireCashModal();
    showToast('Caja Abierta', `Turno iniciado con S/ ${amount.toFixed(2)}`);
    await loadCashStatus();
  } catch (err) {
    alert('❌ ' + err.message);
  }
}

async function loadCashStatus() {
  const panel = document.getElementById('cash-status-panel');
  const indicator = document.getElementById('sidebar-cash-indicator');
  const topbarCash = document.getElementById('topbar-cash-badge');

  try {
    const res = await fetch('/api/cash/status');
    const data = await res.json();

    isCashRegisterOpen = data.isOpen;

    if (indicator) {
      if (data.isOpen) {
        indicator.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-500 inline-block animate-pulse"></span> Caja Abierta (Turno Activo)';
        indicator.className = 'text-[10px] text-emerald-400 font-bold flex items-center gap-1.5';
      } else {
        indicator.innerHTML = '<span class="w-2 h-2 rounded-full bg-rose-500 inline-block"></span> Caja Cerrada';
        indicator.className = 'text-[10px] text-rose-400 font-bold flex items-center gap-1.5';
      }
    }

    if (topbarCash) {
      if (data.isOpen) {
        topbarCash.className = 'flex items-center gap-2 px-3 py-1.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-bold cursor-pointer hover:bg-emerald-100 transition-all';
        topbarCash.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span><span>Caja Abierta · Efectivo: <strong class="font-mono-code tabular-nums">S/ ${(data.expectedCash || 0).toFixed(2)}</strong></span>`;
      } else {
        topbarCash.className = 'flex items-center gap-2 px-3 py-1.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-bold cursor-pointer hover:bg-rose-100 transition-all';
        topbarCash.innerHTML = '<span class="w-2 h-2 rounded-full bg-rose-500"></span><span>Caja Cerrada (Abrir Turno)</span>';
      }
    }

    if (!panel) return;

    if (!data.isOpen) {
      panel.innerHTML = `
        <div class="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm max-w-md mx-auto text-center space-y-4">
          <div class="w-16 h-16 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center text-2xl mx-auto shadow-inner">
            <i class="fa-solid fa-lock"></i>
          </div>
          <h3 class="text-lg font-black text-slate-900">Caja de Turno Cerrada</h3>
          <p class="text-xs text-slate-500">Para procesar ventas y registrar movimientos de mostrador, abra el turno de caja.</p>
          <div class="space-y-3 pt-2 text-left bg-slate-50 p-4 rounded-2xl border border-slate-100">
            <div>
              <label class="text-xs font-bold text-slate-700 block mb-1">Monto Inicial en Efectivo (S/):</label>
              <input type="number" step="0.50" id="cash-open-amount" value="50.00" class="w-full p-2.5 border border-slate-300 rounded-xl text-sm font-mono-code tabular-nums font-black outline-none focus:ring-2 focus:ring-indigo-500">
            </div>
            <button onclick="openCashRegister()" class="btn-tactile w-full bg-indigo-600 hover:bg-indigo-700 text-white font-black py-3 rounded-xl text-xs shadow-md uppercase">
              <i class="fa-solid fa-key mr-1"></i> Abrir Caja de Hoy
            </button>
          </div>
        </div>
      `;
    } else {
      const reg = data.register;
      const movs = data.movements || [];

      const movsTableRows = movs.length === 0 ? `
        <tr><td colspan="5" class="p-6 text-center text-slate-400 font-bold">No se registran movimientos manuales o abonos en este turno.</td></tr>
      ` : movs.map(m => `
        <tr class="hover:bg-slate-50/80 transition-colors">
          <td class="p-3.5 text-slate-500 font-mono-code text-xs">${new Date(m.created_at).toLocaleTimeString()}</td>
          <td class="p-3.5 font-bold">
            <span class="px-2.5 py-0.5 rounded-lg text-[10px] font-black ${m.type === 'INGRESO' ? 'bg-emerald-100 text-emerald-700' : (m.type === 'ABONO' ? 'bg-indigo-100 text-indigo-700' : 'bg-rose-100 text-rose-700')}">
              ${m.type}
            </span>
          </td>
          <td class="p-3.5 font-medium text-slate-800">${m.reason}</td>
          <td class="p-3.5 text-slate-600 font-bold text-xs">${m.payment_method || 'Efectivo'}</td>
          <td class="p-3.5 text-right font-mono-code tabular-nums font-black ${m.type === 'RETIRO' ? 'text-rose-600' : 'text-emerald-700'}">
            ${m.type === 'RETIRO' ? '-' : '+'} S/ ${parseFloat(m.amount).toFixed(2)}
          </td>
        </tr>
      `).join('');

      panel.innerHTML = `
        <div class="space-y-6">
          <!-- TARJETAS DE ARQUEO MULTICANAL EN VIVO -->
          <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div class="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm">
              <p class="text-[10px] uppercase font-bold text-slate-400">1. Saldo Inicial</p>
              <p class="text-xl font-mono-code tabular-nums font-black text-slate-800 mt-1">S/ ${data.initialAmount.toFixed(2)}</p>
              <p class="text-[11px] text-slate-400 mt-1">Apertura: ${new Date(reg.opened_at).toLocaleTimeString()}</p>
            </div>
            
            <div class="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm">
              <p class="text-[10px] uppercase font-bold text-slate-400">2. Ventas Efectivo</p>
              <p class="text-xl font-mono-code tabular-nums font-black text-emerald-600 mt-1">S/ ${data.efectivoSales.toFixed(2)}</p>
              <p class="text-[11px] font-mono-code tabular-nums text-slate-400 mt-1">+ S/ ${(data.abonosEfectivo || 0).toFixed(2)} de abonos</p>
            </div>

            <div class="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm">
              <p class="text-[10px] uppercase font-bold text-slate-400">3. Ventas Digitales</p>
              <p class="text-xl font-mono-code tabular-nums font-black text-indigo-600 mt-1">S/ ${(data.yapeSales + data.tarjetaSales).toFixed(2)}</p>
              <p class="text-[11px] font-mono-code tabular-nums text-slate-400 mt-1">Yape/Plin: S/ ${data.yapeSales.toFixed(2)} | Tarj: S/ ${data.tarjetaSales.toFixed(2)}</p>
            </div>

            <div class="bg-gradient-to-tr from-slate-900 to-indigo-950 p-5 rounded-3xl text-white shadow-lg">
              <p class="text-[10px] uppercase font-bold text-indigo-300">4. Efectivo Físico Esperado</p>
              <p class="text-2xl font-mono-code tabular-nums font-black text-white mt-1">S/ ${data.expectedCash.toFixed(2)}</p>
              <p class="text-[11px] font-mono-code tabular-nums text-slate-400 mt-1">Total vendido turno: S/ ${data.totalSales.toFixed(2)}</p>
            </div>
          </div>

          <!-- TABLA DE MOVIMIENTOS Y GASTOS VISIBLES EN VIVO -->
          <div class="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden space-y-2">
            <div class="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <h4 class="font-black text-xs text-slate-800 flex items-center gap-2">
                <i class="fa-solid fa-list-check text-indigo-600"></i> Movimientos, Gastos y Abonos del Turno
              </h4>
              <span class="text-xs font-mono-code tabular-nums font-bold text-slate-500">${movs.length} registros</span>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-left">
                <thead class="bg-slate-50 text-slate-500 font-bold uppercase text-[10px] tracking-wider">
                  <tr>
                    <th class="p-3.5">Hora</th>
                    <th class="p-3.5">Tipo</th>
                    <th class="p-3.5">Motivo / Detalle</th>
                    <th class="p-3.5">Método</th>
                    <th class="p-3.5 text-right">Monto</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100">${movsTableRows}</tbody>
              </table>
            </div>
          </div>

          <!-- BOTONES DE ACCIÓN: MOVIMIENTO Y CIERRE -->
          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <!-- REGISTRAR MOVIMIENTO MANUAL -->
            <div class="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm space-y-3">
              <h4 class="font-black text-sm text-slate-800 flex items-center gap-2">
                <i class="fa-solid fa-money-bill-transfer text-indigo-600"></i> Registrar Gasto / Ingreso Manual
              </h4>
              <div class="grid grid-cols-3 gap-3">
                <div>
                  <label class="text-[10px] font-bold text-slate-500 uppercase">Tipo</label>
                  <select id="mov-type" class="w-full p-2 border border-slate-200 rounded-xl text-xs font-bold outline-none">
                    <option value="RETIRO">Gasto / Retiro</option>
                    <option value="INGRESO">Ingreso Extra</option>
                  </select>
                </div>
                <div>
                  <label class="text-[10px] font-bold text-slate-500 uppercase">Monto (S/)</label>
                  <input type="number" step="0.50" id="mov-amount" placeholder="0.00" class="w-full p-2 border border-slate-200 rounded-xl text-xs font-mono-code tabular-nums font-bold outline-none">
                </div>
                <div>
                  <label class="text-[10px] font-bold text-slate-500 uppercase">Medio</label>
                  <select id="mov-method" class="w-full p-2 border border-slate-200 rounded-xl text-xs font-bold outline-none">
                    <option value="Efectivo">Efectivo</option>
                    <option value="Yape/Plin">Yape/Plin</option>
                  </select>
                </div>
              </div>
              <div>
                <label class="text-[10px] font-bold text-slate-500 uppercase">Motivo / Detalle *</label>
                <input type="text" id="mov-reason" placeholder="Ej. Pago de almuerzo, compra de cinta térmica, cambio sencillo..." class="w-full p-2 border border-slate-200 rounded-xl text-xs outline-none">
              </div>
              <button onclick="registerCashMovement()" class="btn-tactile w-full bg-slate-800 hover:bg-slate-900 text-white font-bold py-2.5 rounded-xl text-xs shadow-sm">
                Guardar Movimiento
              </button>
            </div>

            <!-- CIERRE DE CAJA / ARQUEO Z -->
            <div class="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm space-y-3">
              <h4 class="font-black text-sm text-slate-800 flex items-center gap-2">
                <i class="fa-solid fa-file-invoice-dollar text-emerald-600"></i> Realizar Corte de Caja (Arqueo Z)
              </h4>
              <div>
                <label class="text-[10px] font-bold text-slate-500 uppercase">Efectivo Real Contado en Gaveta (S/) *</label>
                <input type="number" step="0.50" id="close-final-amount" placeholder="Monto contado físicamente..." class="w-full p-2 border border-slate-200 rounded-xl font-mono-code tabular-nums font-black outline-none text-indigo-700 text-sm">
              </div>
              <div>
                <label class="text-[10px] font-bold text-slate-500 uppercase">Observaciones de Cierre</label>
                <input type="text" id="close-notes" placeholder="Notas de cuadre (opcional)..." class="w-full p-2 border border-slate-200 rounded-xl text-xs outline-none">
              </div>
              <button onclick="closeCashRegister()" class="btn-tactile w-full bg-rose-600 hover:bg-rose-700 text-white font-black py-2.5 rounded-xl text-xs shadow-sm uppercase">
                <i class="fa-solid fa-lock mr-1"></i> Cerrar Turno y Generar Arqueo Z
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
      headers: getAuthHeaders(),
      body: JSON.stringify({ initial_amount: amount })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error');
    showToast('Caja Abierta', `Turno iniciado con S/ ${amount.toFixed(2)}`);
    await loadCashStatus();
  } catch (err) { alert('❌ Error: ' + err.message); }
}

async function registerCashMovement() {
  const type = document.getElementById('mov-type').value;
  const amount = parseFloat(document.getElementById('mov-amount').value);
  const reason = document.getElementById('mov-reason').value.trim();
  const payment_method = document.getElementById('mov-method')?.value || 'Efectivo';

  if (!amount || amount <= 0 || !reason) {
    alert('⚠️ Ingrese un monto válido y el motivo o detalle del gasto/ingreso.');
    return;
  }

  try {
    const res = await fetch('/api/cash/movement', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ type, amount, reason, payment_method })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error');

    showToast('Movimiento Guardado', `${type}: S/ ${amount.toFixed(2)}`);
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
      headers: getAuthHeaders(),
      body: JSON.stringify({ final_amount: finalAmount, notes })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error');

    const s = data.summary;
    showToast('Arqueo Z Generado', `Diferencia: S/ ${s.difference.toFixed(2)}`);
    await loadCashStatus();
    await loadCashHistory();

    // Renderizar Ticket Térmico de Arqueo Z
    renderArqueoZTicket(s);
    document.getElementById('modal-ticket').classList.remove('hidden');
  } catch (err) { alert('❌ Error: ' + err.message); }
}

async function loadCashHistory() {
  const panel = document.getElementById('cash-history-panel');
  if (!panel) return;

  try {
    const res = await fetch('/api/cash/history');
    CASH_HISTORY = await res.json();

    if (!Array.isArray(CASH_HISTORY) || CASH_HISTORY.length === 0) {
      panel.innerHTML = '';
      return;
    }

    const rowsHtml = CASH_HISTORY.map(r => {
      const diff = parseFloat(r.difference || 0);
      const diffClass = Math.abs(diff) < 0.01 ? 'bg-emerald-100 text-emerald-700' : (diff > 0 ? 'bg-indigo-100 text-indigo-700' : 'bg-rose-100 text-rose-700');
      const diffLabel = Math.abs(diff) < 0.01 ? 'EXACTO' : (diff > 0 ? `+S/ ${diff.toFixed(2)}` : `S/ ${diff.toFixed(2)}`);

      return `
        <tr class="hover:bg-slate-50/80 transition-colors">
          <td class="p-3.5 font-mono-code font-bold text-slate-700 text-xs">#${r.id}</td>
          <td class="p-3.5 text-slate-500 text-xs">${new Date(r.opened_at).toLocaleString()}</td>
          <td class="p-3.5 text-slate-500 text-xs">${r.closed_at ? new Date(r.closed_at).toLocaleString() : '-'}</td>
          <td class="p-3.5 text-right font-mono-code tabular-nums font-bold text-slate-700">S/ ${parseFloat(r.initial_amount || 0).toFixed(2)}</td>
          <td class="p-3.5 text-right font-mono-code tabular-nums font-bold text-slate-800">S/ ${parseFloat(r.expected_amount || 0).toFixed(2)}</td>
          <td class="p-3.5 text-right font-mono-code tabular-nums font-black text-indigo-700">S/ ${parseFloat(r.final_amount || 0).toFixed(2)}</td>
          <td class="p-3.5 text-center">
            <span class="px-2.5 py-0.5 rounded-full font-mono-code tabular-nums text-[10px] font-black ${diffClass}">${diffLabel}</span>
          </td>
          <td class="p-3.5 text-slate-500 truncate max-w-xs text-xs">${r.notes || '-'}</td>
          <td class="p-3.5 text-center">
            <button onclick="reprintArqueoZ(${r.id})" class="btn-tactile bg-indigo-50 text-indigo-600 hover:bg-indigo-100 hover:text-indigo-800 px-2.5 py-1 rounded-xl font-bold text-xs" title="Imprimir Arqueo Z">
              <i class="fa-solid fa-print mr-1"></i> Arqueo Z
            </button>
          </td>
        </tr>
      `;
    }).join('');

    panel.innerHTML = `
      <div class="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
        <div class="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
          <h4 class="font-black text-xs text-slate-800 flex items-center gap-2 uppercase tracking-wider">
            <i class="fa-solid fa-clock-rotate-left text-indigo-600"></i> Historial de Cierres de Caja (Arqueos Z Anteriores)
          </h4>
          <span class="text-xs font-mono-code tabular-nums font-bold text-slate-400">Últimos ${CASH_HISTORY.length} cierres</span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead class="bg-slate-50 text-slate-500 font-bold uppercase text-[10px] tracking-wider">
              <tr>
                <th class="p-3.5">Turno</th>
                <th class="p-3.5">Apertura</th>
                <th class="p-3.5">Cierre</th>
                <th class="p-3.5 text-right">Inicial</th>
                <th class="p-3.5 text-right">Esperado</th>
                <th class="p-3.5 text-right">Contado</th>
                <th class="p-3.5 text-center">Diferencia</th>
                <th class="p-3.5">Notas</th>
                <th class="p-3.5 text-center">Ticket</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">${rowsHtml}</tbody>
          </table>
        </div>
      </div>
    `;
  } catch (err) {
    console.error('Error cargando historial de caja:', err);
  }
}

function reprintArqueoZ(registerId) {
  const reg = CASH_HISTORY.find(r => r.id === registerId);
  if (!reg) return;
  renderArqueoZTicket({
    registerId: reg.id,
    openedAt: reg.opened_at,
    closedAt: reg.closed_at,
    initialAmount: parseFloat(reg.initial_amount || 0),
    expectedAmount: parseFloat(reg.expected_amount || 0),
    finalAmount: parseFloat(reg.final_amount || 0),
    difference: parseFloat(reg.difference || 0),
    notes: reg.notes || ''
  });
  document.getElementById('modal-ticket').classList.remove('hidden');
}

function renderArqueoZTicket(s) {
  const container = document.getElementById('thermal-ticket-container');
  if (!container) return;

  const diff = parseFloat(s.difference || 0);
  const statusText = Math.abs(diff) < 0.01 ? 'CUADRE EXACTO' : (diff > 0 ? 'SOBRANTE' : 'FALTANTE');
  const regId = s.registerId || s.register_id || '-';
  const openedAt = s.openedAt || s.opened_at || Date.now();
  const closedAt = s.closedAt || s.closed_at || Date.now();
  const cashSales = s.efectivoSales !== undefined ? s.efectivoSales : s.cashSales;

  container.innerHTML = `
    <div style="text-align: center; border-bottom: 1px dashed #666; padding-bottom: 6px; margin-bottom: 6px;">
      <div style="font-size: 14px; font-weight: bold;">CELLVENTAS</div>
      <div>CORTE DE CAJA - ARQUEO Z</div>
      <div style="margin-top: 4px; font-weight: bold;">TURNO #${regId}</div>
      <div style="font-size: 10px;">Apertura: ${new Date(openedAt).toLocaleString()}</div>
      <div style="font-size: 10px;">Cierre: ${new Date(closedAt).toLocaleString()}</div>
    </div>

    <div style="padding: 4px 0; border-bottom: 1px dashed #666;">
      <div style="display: flex; justify-content: space-between;">
        <span>Saldo Inicial:</span>
        <span>S/ ${parseFloat(s.initialAmount || 0).toFixed(2)}</span>
      </div>
      ${cashSales !== undefined ? `
        <div style="display: flex; justify-content: space-between;">
          <span>Ventas Efectivo:</span>
          <span>+ S/ ${parseFloat(cashSales || 0).toFixed(2)}</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span>Abonos Efectivo:</span>
          <span>+ S/ ${parseFloat(s.abonosEfectivo || 0).toFixed(2)}</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span>Ingresos Manuales:</span>
          <span>+ S/ ${parseFloat(s.ingresos ?? s.ingresosManuales ?? 0).toFixed(2)}</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span>Gastos / Retiros:</span>
          <span>- S/ ${parseFloat(s.retiros ?? s.retirosManuales ?? 0).toFixed(2)}</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-top: 4px; border-top: 1px dotted #999; padding-top: 2px;">
          <span>Ventas Yape/Plin:</span>
          <span>S/ ${parseFloat(s.yapeSales || 0).toFixed(2)}</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span>Ventas Tarjeta:</span>
          <span>S/ ${parseFloat(s.tarjetaSales || 0).toFixed(2)}</span>
        </div>
      ` : ''}
    </div>

    <div style="padding: 6px 0; border-bottom: 1px dashed #666;">
      <div style="display: flex; justify-content: space-between; font-weight: bold;">
        <span>EFECTIVO ESPERADO:</span>
        <span>S/ ${parseFloat(s.expectedAmount || 0).toFixed(2)}</span>
      </div>
      <div style="display: flex; justify-content: space-between; font-weight: bold; font-size: 13px; margin: 4px 0;">
        <span>EFECTIVO CONTADO:</span>
        <span>S/ ${parseFloat(s.finalAmount || 0).toFixed(2)}</span>
      </div>
      <div style="display: flex; justify-content: space-between; font-weight: bold;">
        <span>DIFERENCIA (${statusText}):</span>
        <span>S/ ${diff.toFixed(2)}</span>
      </div>
    </div>

    ${s.notes ? `<div style="padding: 4px 0; font-size: 11px;">OBS: ${s.notes}</div>` : ''}

    <div style="text-align: center; margin-top: 18px; font-size: 11px;">
      <div style="border-top: 1px solid #000; width: 80%; margin: 0 auto; padding-top: 4px;">
        Firma Responsable de Caja
      </div>
    </div>
  `;
}

// ==============================================================
// 9. INVENTARIO, CRM & CRÉDITOS (CON RECIBO TÉRMICO DE ABONO)
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

function openProductModal(productId = null) {
  const idInput = document.getElementById('prod-id');
  const titleEl = document.getElementById('modal-product-title');
  const codeInput = document.getElementById('prod-code');
  const nameInput = document.getElementById('prod-name');
  const catInput = document.getElementById('prod-category');
  const purchaseInput = document.getElementById('prod-purchase');
  const priceInput = document.getElementById('prod-price');
  const stockInput = document.getElementById('prod-stock');
  const minStockInput = document.getElementById('prod-min-stock');
  const serializedInput = document.getElementById('prod-serialized');

  document.querySelectorAll('input[name="compat_models"]').forEach(cb => { cb.checked = false; });

  if (productId) {
    const p = PRODUCTS.find(prod => prod.id === productId);
    if (!p) return;

    if (idInput) idInput.value = p.id;
    if (titleEl) titleEl.innerText = `Editar Producto (#${p.code})`;
    codeInput.value = p.code || '';
    nameInput.value = p.name || '';
    catInput.value = p.category || 'Cases / Fundas';
    purchaseInput.value = parseFloat(p.purchase_price || 0).toFixed(2);
    priceInput.value = parseFloat(p.price || 0).toFixed(2);
    stockInput.value = p.stock || 0;
    if (minStockInput) minStockInput.value = p.min_stock || 5;

    toggleSerializedCheckbox();
    if (serializedInput) serializedInput.checked = p.is_serialized === 1;

    const compatIds = (p.compatible_models || []).map(m => Number(m.id));
    document.querySelectorAll('input[name="compat_models"]').forEach(cb => {
      if (compatIds.includes(Number(cb.value))) cb.checked = true;
    });
  } else {
    if (idInput) idInput.value = '';
    if (titleEl) titleEl.innerText = 'Registrar Producto o Accesorio';
    codeInput.value = '';
    nameInput.value = '';
    catInput.value = 'Cases / Fundas';
    purchaseInput.value = '0.00';
    priceInput.value = '';
    stockInput.value = '10';
    if (minStockInput) minStockInput.value = '5';
    toggleSerializedCheckbox();
  }

  document.getElementById('modal-product').classList.remove('hidden');
}

function closeProductModal() { document.getElementById('modal-product').classList.add('hidden'); }

async function saveProduct(e) {
  e.preventDefault();
  const prodId = document.getElementById('prod-id')?.value;
  const selectedModelIds = Array.from(document.querySelectorAll('input[name="compat_models"]:checked')).map(cb => parseInt(cb.value));

  const payload = {
    code: document.getElementById('prod-code').value.trim(),
    name: document.getElementById('prod-name').value.trim(),
    category: document.getElementById('prod-category').value,
    purchase_price: parseFloat(document.getElementById('prod-purchase').value) || 0,
    price: parseFloat(document.getElementById('prod-price').value),
    stock: parseInt(document.getElementById('prod-stock').value) || 0,
    min_stock: parseInt(document.getElementById('prod-min-stock')?.value) || 5,
    is_serialized: document.getElementById('prod-serialized')?.checked ? 1 : 0,
    model_ids: selectedModelIds
  };

  try {
    const url = prodId ? `/api/products/${prodId}` : '/api/products';
    const method = prodId ? 'PUT' : 'POST';
    const res = await fetch(url, {
      method,
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al guardar producto');
    closeProductModal();
    await loadProducts();
    await loadCoverageData();
    await loadDashboard();
    showToast(prodId ? 'Producto Actualizado' : 'Producto Guardado', `${payload.name} guardado correctamente.`);
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
    const minStock = p.min_stock || 5;
    return `
      <tr class="hover:bg-slate-50/80 transition-colors">
        <td class="p-4 font-mono-code font-bold text-slate-500 text-xs">${p.code}</td>
        <td class="p-4 font-bold text-slate-900">${p.name}</td>
        <td class="p-4"><span class="bg-slate-100 text-slate-700 px-2.5 py-0.5 rounded-lg text-[11px] font-bold">${p.category}</span></td>
        <td class="p-4 text-xs text-indigo-700 font-semibold truncate max-w-xs">${modelsStr}</td>
        <td class="p-4 text-right font-mono-code tabular-nums font-bold text-slate-500">S/ ${(p.purchase_price || 0).toFixed(2)}</td>
        <td class="p-4 text-right font-mono-code tabular-nums font-black text-slate-900">S/ ${p.price.toFixed(2)}</td>
        <td class="p-4 text-center">
          <span class="${p.stock <= minStock ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'} px-2.5 py-0.5 rounded-lg font-mono-code tabular-nums font-black text-xs">
            ${p.stock} und.
          </span>
        </td>
        <td class="p-4 text-center">
          <div class="flex items-center justify-center gap-1.5">
            <button onclick="openKardexModal(${p.id})" class="action-icon-btn bg-amber-50 text-amber-600 hover:bg-amber-100 hover:text-amber-800" title="Ver Kardex / Historial de Movimientos"><i class="fa-solid fa-clock-rotate-left text-xs"></i></button>
            <button onclick="openStockAdjustmentModal(${p.id})" class="action-icon-btn bg-emerald-50 text-emerald-600 hover:bg-emerald-100 hover:text-emerald-800" title="Ajustar Stock / Entrada / Merma"><i class="fa-solid fa-boxes-packing text-xs"></i></button>
            <button onclick="openProductModal(${p.id})" class="action-icon-btn bg-indigo-50 text-indigo-600 hover:bg-indigo-100 hover:text-indigo-800" title="Editar Producto"><i class="fa-solid fa-pen-to-square text-xs"></i></button>
            <button onclick="deleteProduct(${p.id})" class="action-icon-btn bg-rose-50 text-rose-600 hover:bg-rose-100 hover:text-rose-800" title="Eliminar Producto"><i class="fa-solid fa-trash text-xs"></i></button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function deleteProduct(id) {
  if (!confirm('¿Eliminar este producto del almacén?')) return;
  await fetch('/api/products/' + id, { method: 'DELETE', headers: getAuthHeaders() });
  await loadProducts();
  await loadCoverageData();
}

// ==========================================
// KARDEX DE ALMACÉN Y AJUSTES DE STOCK (ANTI-MERMA)
// ==========================================
let CURRENT_KARDEX_PRODUCT_ID = null;
let RAW_KARDEX_MOVEMENTS = [];

async function openGeneralKardexModal() {
  CURRENT_KARDEX_PRODUCT_ID = null;
  const modal = document.getElementById('modal-kardex');
  const title = document.getElementById('modal-kardex-title');
  const badge = document.getElementById('modal-kardex-badge');
  const subtitle = document.getElementById('modal-kardex-subtitle');
  const sInput = document.getElementById('kardex-search-input');
  const tFilter = document.getElementById('kardex-type-filter');

  if (sInput) sInput.value = '';
  if (tFilter) tFilter.value = 'ALL';

  if (title) title.innerText = 'Kardex de Inventario - Almacén General';
  if (badge) {
    badge.innerText = 'General';
    badge.className = 'px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-indigo-100 text-indigo-700';
  }
  if (subtitle) subtitle.innerText = 'Historial global de movimientos y auditoría anti-merma.';

  if (modal) modal.classList.remove('hidden');
  await refreshCurrentKardex();
}

async function openKardexModal(productId) {
  CURRENT_KARDEX_PRODUCT_ID = productId;
  const p = PRODUCTS.find(x => x.id === productId);
  const modal = document.getElementById('modal-kardex');
  const title = document.getElementById('modal-kardex-title');
  const badge = document.getElementById('modal-kardex-badge');
  const subtitle = document.getElementById('modal-kardex-subtitle');
  const sInput = document.getElementById('kardex-search-input');
  const tFilter = document.getElementById('kardex-type-filter');

  if (sInput) sInput.value = '';
  if (tFilter) tFilter.value = 'ALL';

  if (title) title.innerText = p ? `Kardex: ${p.name}` : 'Kardex de Producto';
  if (badge) {
    badge.innerText = p ? p.code : 'SKU';
    badge.className = 'px-2.5 py-0.5 rounded-full text-[11px] font-mono-code font-bold bg-amber-100 text-amber-800';
  }
  if (subtitle) subtitle.innerText = p ? `Categoría: ${p.category} | Stock actual: ${p.stock} und.` : '';

  if (modal) modal.classList.remove('hidden');
  await refreshCurrentKardex();
}

function closeKardexModal() {
  const modal = document.getElementById('modal-kardex');
  if (modal) modal.classList.add('hidden');
}

async function refreshCurrentKardex() {
  const tbody = document.getElementById('kardex-table-body');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-slate-400 font-semibold"><i class="fa-solid fa-spinner fa-spin mr-2"></i> Cargando movimientos del Kardex...</td></tr>`;

  try {
    const url = CURRENT_KARDEX_PRODUCT_ID 
      ? `/api/inventory/kardex/${CURRENT_KARDEX_PRODUCT_ID}` 
      : `/api/inventory/kardex`;

    const res = await fetch(url, { headers: getAuthHeaders() });
    const movements = await res.json();

    if (!Array.isArray(movements)) {
      tbody.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-rose-500 font-semibold">Error al interpretar respuesta del servidor.</td></tr>`;
      return;
    }

    RAW_KARDEX_MOVEMENTS = movements;
    filterKardexRows();

  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-rose-500 font-semibold">Error al cargar movimientos: ${err.message}</td></tr>`;
  }
}

function filterKardexRows() {
  const searchInput = document.getElementById('kardex-search-input');
  const typeFilter = document.getElementById('kardex-type-filter');
  const term = searchInput ? searchInput.value.trim().toLowerCase() : '';
  const filterType = typeFilter ? typeFilter.value : 'ALL';

  let filtered = RAW_KARDEX_MOVEMENTS;

  if (filterType !== 'ALL') {
    filtered = filtered.filter(m => {
      if (filterType === 'STOCK_INICIAL') return m.type === 'STOCK_INICIAL';
      if (filterType === 'ENTRADA') return m.type === 'ENTRADA';
      if (filterType === 'VENTA') return m.type === 'VENTA';
      if (filterType === 'SALIDA') return m.type === 'SALIDA';
      if (filterType === 'ANULACION') return m.type === 'ANULACION';
      return m.type === filterType;
    });
  }

  if (term) {
    filtered = filtered.filter(m => {
      const pName = (m.product_name || '').toLowerCase();
      const pCode = (m.product_code || '').toLowerCase();
      const reason = (m.reason || '').toLowerCase();
      const ref = (m.reference_code || '').toLowerCase();
      const user = (m.user_name || '').toLowerCase();
      return pName.includes(term) || pCode.includes(term) || reason.includes(term) || ref.includes(term) || user.includes(term);
    });
  }

  renderKardexRows(filtered);
}

function renderKardexRows(movements) {
  const tbody = document.getElementById('kardex-table-body');
  if (!tbody) return;

  const statEnt = document.getElementById('kardex-stat-entradas');
  const statSal = document.getElementById('kardex-stat-salidas');
  const statStk = document.getElementById('kardex-stat-stock');
  const totalRec = document.getElementById('kardex-total-records');

  if (!Array.isArray(movements) || movements.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="p-8 text-center text-slate-400 font-semibold"><i class="fa-solid fa-folder-open text-2xl mb-2 block text-slate-300"></i> No se encontraron movimientos con los filtros aplicados.</td></tr>`;
    if (statEnt) statEnt.innerText = '0 und.';
    if (statSal) statSal.innerText = '0 und.';
    if (statStk) statStk.innerText = CURRENT_KARDEX_PRODUCT_ID ? `${PRODUCTS.find(x => x.id === CURRENT_KARDEX_PRODUCT_ID)?.stock || 0} und.` : '-';
    if (totalRec) totalRec.innerText = '0 movimientos mostrados';
    return;
  }

  let totalEntradas = 0;
  let totalSalidas = 0;

  tbody.innerHTML = movements.map(m => {
    const isEntry = m.type === 'ENTRADA' || m.type === 'STOCK_INICIAL' || m.type === 'ANULACION';
    const isExit = m.type === 'SALIDA' || m.type === 'VENTA';

    if (isEntry) totalEntradas += Number(m.quantity || 0);
    if (isExit) totalSalidas += Number(m.quantity || 0);

    let typeBadge = '';
    if (m.type === 'STOCK_INICIAL') {
      typeBadge = `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-700 inline-flex items-center gap-1"><i class="fa-solid fa-box text-[9px]"></i> INICIAL</span>`;
    } else if (m.type === 'ENTRADA') {
      typeBadge = `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-700 inline-flex items-center gap-1"><i class="fa-solid fa-arrow-down text-[9px]"></i> ENTRADA</span>`;
    } else if (m.type === 'VENTA') {
      typeBadge = `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-purple-100 text-purple-700 inline-flex items-center gap-1"><i class="fa-solid fa-cart-shopping text-[9px]"></i> VENTA</span>`;
    } else if (m.type === 'SALIDA') {
      typeBadge = `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-700 inline-flex items-center gap-1"><i class="fa-solid fa-arrow-up text-[9px]"></i> MERMA/SALIDA</span>`;
    } else if (m.type === 'ANULACION') {
      typeBadge = `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-teal-100 text-teal-700 inline-flex items-center gap-1"><i class="fa-solid fa-rotate-left text-[9px]"></i> ANULACIÓN</span>`;
    } else {
      typeBadge = `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700 inline-flex items-center gap-1">${m.type}</span>`;
    }

    const qtySign = isEntry ? `+${m.quantity}` : (isExit ? `-${m.quantity}` : `${m.quantity}`);
    const qtyClass = isEntry ? 'text-emerald-600 font-black' : (isExit ? 'text-rose-600 font-black' : 'text-amber-600 font-black');

    const dateStr = new Date(m.created_at).toLocaleString('es-PE', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });

    return `
      <tr class="hover:bg-slate-50/90 transition-colors">
        <td class="p-3 text-slate-500 font-mono-code text-[11px] whitespace-nowrap">${dateStr}</td>
        <td class="p-3">
          <div class="font-bold text-slate-800 text-xs">${m.product_name || 'Producto #' + m.product_id}</div>
          <div class="text-[10px] font-mono-code text-indigo-600 font-bold mt-0.5">${m.product_code || ''}</div>
        </td>
        <td class="p-3 text-center whitespace-nowrap">${typeBadge}</td>
        <td class="p-3 text-right font-mono-code ${qtyClass} text-xs tabular-nums">${qtySign}</td>
        <td class="p-3 text-center font-mono-code text-xs text-slate-600 tabular-nums">
          <span class="text-slate-400 font-medium">${m.previous_stock}</span> <i class="fa-solid fa-arrow-right text-[10px] text-slate-400 mx-1"></i> <span class="font-bold text-slate-900">${m.new_stock}</span>
        </td>
        <td class="p-3 text-xs text-slate-600">
          <div class="font-medium text-slate-800">${m.reason || '-'}</div>
          ${m.reference_code ? `<span class="inline-block mt-0.5 text-[10px] font-mono-code text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded font-bold">Ref: ${m.reference_code}</span>` : ''}
        </td>
        <td class="p-3 text-slate-500 text-[11px] whitespace-nowrap">
          <span class="inline-flex items-center gap-1 font-medium"><i class="fa-solid fa-user-shield text-[10px] text-slate-400"></i>${m.user_name || 'Sistema'}</span>
        </td>
      </tr>
    `;
  }).join('');

  if (statEnt) statEnt.innerText = `${totalEntradas} und.`;
  if (statSal) statSal.innerText = `${totalSalidas} und.`;
  if (statStk) {
    if (CURRENT_KARDEX_PRODUCT_ID) {
      const currProd = PRODUCTS.find(x => x.id === CURRENT_KARDEX_PRODUCT_ID);
      statStk.innerText = currProd ? `${currProd.stock} und.` : '-';
    } else {
      statStk.innerText = 'General';
    }
  }
  if (totalRec) totalRec.innerText = `${movements.length} movimientos mostrados (de ${RAW_KARDEX_MOVEMENTS.length})`;
}

function openStockAdjustmentModal(productId = null) {
  const modal = document.getElementById('modal-stock-adjustment');
  const select = document.getElementById('adjust-product-id');
  const qtyInput = document.getElementById('adjust-quantity');
  const reasonInput = document.getElementById('adjust-reason');
  const refInput = document.getElementById('adjust-reference');
  const typeSelect = document.getElementById('adjust-type');

  if (select) {
    select.innerHTML = '<option value="">-- Seleccionar Producto --</option>' + 
      PRODUCTS.map(p => `<option value="${p.id}" ${productId === p.id ? 'selected' : ''}>${p.code} - ${p.name} (Stock: ${p.stock})</option>`).join('');
  }

  if (qtyInput) qtyInput.value = '';
  if (reasonInput) reasonInput.value = '';
  if (refInput) refInput.value = '';
  if (typeSelect) typeSelect.value = 'ENTRADA';

  onAdjustProductChange();
  if (modal) modal.classList.remove('hidden');
}

function closeStockAdjustmentModal() {
  const modal = document.getElementById('modal-stock-adjustment');
  if (modal) modal.classList.add('hidden');
}

function onAdjustProductChange() {
  const select = document.getElementById('adjust-product-id');
  const stockEl = document.getElementById('adjust-current-stock');
  if (!select || !stockEl) return;

  const pid = parseInt(select.value, 10);
  const p = PRODUCTS.find(x => x.id === pid);
  if (p) {
    stockEl.innerText = `${p.stock} und.`;
  } else {
    stockEl.innerText = '0 und.';
  }
}

async function handleStockAdjustmentSubmit(e) {
  e.preventDefault();
  const pid = parseInt(document.getElementById('adjust-product-id')?.value, 10);
  const type = document.getElementById('adjust-type')?.value;
  const quantity = parseInt(document.getElementById('adjust-quantity')?.value, 10);
  const reason = document.getElementById('adjust-reason')?.value?.trim();
  const reference_code = document.getElementById('adjust-reference')?.value?.trim();

  if (!pid) {
    alert('Debe seleccionar un producto.');
    return;
  }
  if (!quantity || quantity <= 0) {
    alert('La cantidad debe ser mayor a 0.');
    return;
  }
  if (!reason) {
    alert('El motivo o justificación del ajuste es obligatorio.');
    return;
  }

  try {
    const res = await fetch('/api/inventory/adjustment', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify({
        product_id: pid,
        type,
        quantity,
        reason,
        reference_code
      })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Error al procesar el ajuste de inventario.');
    }

    alert(`✅ Movimiento registrado con éxito.\n${data.message}`);
    closeStockAdjustmentModal();
    await loadProducts();
    if (document.getElementById('modal-kardex') && !document.getElementById('modal-kardex').classList.contains('hidden')) {
      await refreshCurrentKardex();
    }
  } catch (err) {
    alert(`⚠️ Error: ${err.message}`);
  }
}

function renderFiadosTable() {
  const tbody = document.getElementById('fiados-table-body');
  if (!tbody) return;

  if (CLIENTS.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-slate-400 font-bold">No hay clientes registrados.</td></tr>`;
    return;
  }

  tbody.innerHTML = CLIENTS.map(c => {
    const debt = parseFloat(c.debt || 0);
    return `
      <tr class="hover:bg-slate-50/80 transition-colors">
        <td class="p-4 font-mono-code font-bold text-slate-500 text-xs">${c.doc}</td>
        <td class="p-4 font-bold text-slate-800">${c.name}</td>
        <td class="p-4 font-mono-code text-slate-500 text-xs">${c.phone || '-'}</td>
        <td class="p-4 text-slate-500 text-xs">${c.address || '-'}</td>
        <td class="p-4 text-right font-mono-code tabular-nums font-black ${debt > 0 ? 'text-rose-600' : 'text-slate-400'}">
          S/ ${debt.toFixed(2)}
        </td>
        <td class="p-4 text-center">
          <div class="flex items-center justify-center gap-1.5">
            <button onclick="handleAbonoClick(${c.id})" class="btn-tactile bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-3 py-1.5 rounded-xl text-xs shadow-sm" title="Registrar Abono">
              <i class="fa-solid fa-hand-holding-dollar mr-1"></i> Abonar
            </button>
            <button onclick="openCustomerHistoryModal(${c.id})" class="action-icon-btn bg-slate-100 hover:bg-slate-200 text-slate-700" title="Ver Estado de Cuenta">
              <i class="fa-solid fa-clock-rotate-left text-xs"></i>
            </button>
            <button onclick="openCustomerModal(${c.id})" class="action-icon-btn bg-indigo-50 hover:bg-indigo-100 text-indigo-600" title="Editar Cliente">
              <i class="fa-solid fa-pen text-xs"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function handleAbonoClick(customerId) {
  const customer = CLIENTS.find(c => c.id === customerId);
  if (!customer) return;

  const debt = parseFloat(customer.debt || 0);
  if (debt <= 0) {
    alert(`ℹ️ El cliente "${customer.name}" no registra ninguna deuda pendiente (S/ 0.00).`);
    return;
  }

  document.getElementById('abono-customer-id').value = customer.id;
  document.getElementById('abono-customer-name').innerText = `${customer.name} (${customer.doc})`;
  document.getElementById('abono-current-debt').innerText = `S/ ${debt.toFixed(2)}`;
  document.getElementById('abono-amount').value = debt.toFixed(2);
  document.getElementById('abono-amount').max = debt;
  document.getElementById('modal-abono').classList.remove('hidden');
}

function closeAbonoModal() {
  document.getElementById('modal-abono').classList.add('hidden');
}

async function submitAbono(e) {
  e.preventDefault();
  const customer_id = parseInt(document.getElementById('abono-customer-id').value);
  const amount = parseFloat(document.getElementById('abono-amount').value);
  const payment_method = document.getElementById('abono-payment-method').value;

  if (isNaN(amount) || amount <= 0) {
    alert('⚠️ Ingrese un monto válido.');
    return;
  }

  try {
    const res = await fetch('/api/credits/abono', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ customer_id, amount, payment_method })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al procesar abono');

    closeAbonoModal();
    showToast('Abono Registrado', `S/ ${amount.toFixed(2)} ingresados.`);
    await loadCustomers();
    await loadCashStatus();
    await loadDashboard();

    // Mostrar Recibo Térmico de Abono
    renderAbonoReceipt(data.abonoReceipt);
    document.getElementById('modal-ticket').classList.remove('hidden');

  } catch (err) {
    alert('❌ Error: ' + err.message);
  }
}

// Renderizado del Recibo Térmico de Abono
function renderAbonoReceipt(r) {
  const container = document.getElementById('thermal-ticket-container');
  if (!container) return;

  const dateStr = new Date(r.created_at || Date.now()).toLocaleString();

  container.innerHTML = `
    <div style="text-align: center; border-bottom: 1px dashed #666; padding-bottom: 6px; margin-bottom: 6px;">
      <div style="font-size: 14px; font-weight: bold;">CELLVENTAS</div>
      <div>RECIBO DE ABONO A CRÉDITO</div>
      <div>VT VALETEC</div>
      <div style="margin-top: 4px; font-weight: bold;">RECIBO: ${r.receipt_code}</div>
      <div style="font-size: 11px;">${dateStr}</div>
    </div>

    <div style="border-bottom: 1px dashed #666; padding-bottom: 4px; margin-bottom: 4px;">
      <div>CLIENTE: ${r.customer_name}</div>
      <div>DOC: ${r.customer_doc || '-'}</div>
      <div>MÉTODO DE PAGO: ${r.payment_method}</div>
    </div>

    <div style="padding: 6px 0; border-bottom: 1px dashed #666;">
      <div style="display: flex; justify-content: space-between;">
        <span>Deuda Anterior:</span>
        <span>S/ ${parseFloat(r.previous_debt).toFixed(2)}</span>
      </div>
      <div style="display: flex; justify-content: space-between; font-weight: bold; font-size: 13px; margin: 4px 0;">
        <span>MONTO ABONADO:</span>
        <span>S/ ${parseFloat(r.amount).toFixed(2)}</span>
      </div>
      <div style="display: flex; justify-content: space-between; color: #b91c1c; font-weight: bold;">
        <span>SALDO RESTANTE:</span>
        <span>S/ ${parseFloat(r.new_debt).toFixed(2)}</span>
      </div>
    </div>

    <div style="text-align: center; margin-top: 10px; font-size: 11px;">
      <div>¡Gracias por su abono puntual!</div>
      <div style="margin-top: 25px; border-top: 1px solid #000; width: 80%; margin-left: auto; margin-right: auto; padding-top: 4px;">
        Firma / Sello de Recepción
      </div>
    </div>
  `;
}

function openCustomerModal(customerId = null, fromPos = false) {
  const idInput = document.getElementById('cust-id');
  const fromPosInput = document.getElementById('cust-from-pos');
  const titleEl = document.getElementById('modal-customer-title');
  const docInput = document.getElementById('cust-doc');
  const nameInput = document.getElementById('cust-name');
  const phoneInput = document.getElementById('cust-phone');
  const addressInput = document.getElementById('cust-address');

  if (fromPosInput) fromPosInput.value = fromPos ? '1' : '0';

  if (customerId) {
    const c = CLIENTS.find(cl => cl.id === customerId);
    if (!c) return;
    idInput.value = c.id;
    titleEl.innerText = 'Editar Cliente';
    docInput.value = c.doc || '';
    nameInput.value = c.name || '';
    phoneInput.value = c.phone || '';
    addressInput.value = c.address || '';
  } else {
    idInput.value = '';
    titleEl.innerText = 'Registrar Cliente';
    docInput.value = '';
    nameInput.value = '';
    phoneInput.value = '';
    addressInput.value = '';
  }

  document.getElementById('modal-customer').classList.remove('hidden');
}

function closeCustomerModal() {
  document.getElementById('modal-customer').classList.add('hidden');
}

async function saveCustomer(e) {
  e.preventDefault();
  const custId = document.getElementById('cust-id').value;
  const fromPos = document.getElementById('cust-from-pos').value === '1';
  const payload = {
    doc: document.getElementById('cust-doc').value.trim(),
    name: document.getElementById('cust-name').value.trim(),
    phone: document.getElementById('cust-phone').value.trim(),
    address: document.getElementById('cust-address').value.trim()
  };

  try {
    const url = custId ? `/api/customers/${custId}` : '/api/customers';
    const method = custId ? 'PUT' : 'POST';
    const res = await fetch(url, {
      method,
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al guardar cliente');

    closeCustomerModal();
    await loadCustomers();
    if (fromPos && data.id) {
      const select = document.getElementById('modal-select-customer');
      if (select) select.value = String(data.id);
    }
    showToast(custId ? 'Cliente Actualizado' : 'Cliente Registrado', payload.name);
  } catch (err) {
    alert('❌ Error: ' + err.message);
  }
}

let CURRENT_CUSTOMER_RECORDS = [];
let CURRENT_HISTORY_CUSTOMER = null;

async function openCustomerHistoryModal(customerId) {
  const c = CLIENTS.find(cl => cl.id === customerId);
  if (!c) return;
  CURRENT_HISTORY_CUSTOMER = c;

  document.getElementById('credit-history-customer-label').innerText = `${c.name} (${c.doc}) — Deuda Actual: S/ ${parseFloat(c.debt || 0).toFixed(2)}`;
  const tbody = document.getElementById('credit-history-table-body');
  tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-400 font-bold">Cargando historial...</td></tr>`;
  document.getElementById('modal-customer-history').classList.remove('hidden');

  try {
    const res = await fetch(`/api/credits/${customerId}`);
    CURRENT_CUSTOMER_RECORDS = await res.json();

    if (!Array.isArray(CURRENT_CUSTOMER_RECORDS) || CURRENT_CUSTOMER_RECORDS.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-400 font-bold">No se registran movimientos de crédito o abono para este cliente.</td></tr>`;
      return;
    }

    // Calcular saldo después de cada movimiento en orden cronológico
    const chronological = [...CURRENT_CUSTOMER_RECORDS].reverse();
    let runningBalance = 0;
    const balanceMap = {};
    chronological.forEach(r => {
      const amt = parseFloat(r.amount || 0);
      if (r.type === 'ABONO') {
        runningBalance = Math.max(0, runningBalance - amt);
      } else {
        runningBalance += amt;
      }
      balanceMap[r.id] = runningBalance;
    });

    tbody.innerHTML = CURRENT_CUSTOMER_RECORDS.map(r => {
      const isAbono = r.type === 'ABONO';
      const balanceAfter = balanceMap[r.id] ?? parseFloat(c.debt || 0);
      return `
        <tr class="hover:bg-slate-50/80 transition-colors">
          <td class="p-3 text-slate-500 text-xs">${new Date(r.created_at).toLocaleString()}</td>
          <td class="p-3">
            <span class="px-2.5 py-0.5 rounded-lg text-[10px] font-black ${isAbono ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}">
              ${r.type}
            </span>
          </td>
          <td class="p-3 font-medium text-slate-800">${r.description || '-'}</td>
          <td class="p-3 text-right font-mono-code tabular-nums font-black ${isAbono ? 'text-emerald-700' : 'text-rose-600'}">
            ${isAbono ? '-' : '+'} S/ ${parseFloat(r.amount || 0).toFixed(2)}
          </td>
          <td class="p-3 text-right font-mono-code tabular-nums font-bold text-slate-700">S/ ${balanceAfter.toFixed(2)}</td>
          <td class="p-3 text-center">
            ${isAbono ? `
              <button onclick="reprintAbonoFromRecord(${r.id})" class="action-icon-btn bg-indigo-50 text-indigo-600 hover:bg-indigo-100 hover:text-indigo-800" title="Reimprimir Recibo de Abono">
                <i class="fa-solid fa-print text-xs"></i>
              </button>
            ` : '-'}
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-rose-500 font-bold">Error al cargar estado de cuenta.</td></tr>`;
  }
}

function closeCustomerHistoryModal() {
  document.getElementById('modal-customer-history').classList.add('hidden');
}

function reprintAbonoFromRecord(recordId) {
  const rec = CURRENT_CUSTOMER_RECORDS.find(r => r.id === recordId);
  if (!rec || !CURRENT_HISTORY_CUSTOMER) return;
  const currentDebt = parseFloat(CURRENT_HISTORY_CUSTOMER.debt || 0);
  renderAbonoReceipt({
    receipt_code: `ABN-HIST-${rec.id}`,
    customer_name: CURRENT_HISTORY_CUSTOMER.name,
    customer_doc: CURRENT_HISTORY_CUSTOMER.doc,
    payment_method: rec.payment_method || 'Efectivo',
    previous_debt: currentDebt + parseFloat(rec.amount || 0),
    amount: parseFloat(rec.amount || 0),
    new_debt: currentDebt,
    created_at: rec.created_at
  });
  document.getElementById('modal-ticket').classList.remove('hidden');
}

// ==============================================================
// 10. SERVICIO TÉCNICO (ÓRDENES DE REPARACIÓN)
// ==============================================================
async function loadRepairs() {
  try {
    const res = await fetch('/api/repairs');
    REPAIRS = await res.json();
    const repCountEl = document.getElementById('topbar-repairs-count');
    if (repCountEl && Array.isArray(REPAIRS)) {
      const activeCount = REPAIRS.filter(r => r.status !== 'Entregado' && r.status !== 'Cancelado').length;
      repCountEl.innerText = `${activeCount} en Taller`;
    }
    renderRepairsTable();
  } catch (err) {
    console.error('Error cargando órdenes de servicio:', err);
  }
}

function filterRepairs(status) {
  currentRepairFilter = status;
  ['all', 'Recibido', 'En Reparación', 'Listo', 'Entregado'].forEach(st => {
    const btn = document.getElementById(`rep-filter-${st}`);
    if (btn) {
      btn.className = st === status
        ? 'btn-tactile px-3 py-1.5 bg-indigo-600 text-white rounded-xl text-xs font-bold'
        : 'btn-tactile px-3 py-1.5 bg-slate-100 text-slate-700 rounded-xl text-xs font-bold hover:bg-slate-200';
    }
  });
  renderRepairsTable();
}

function renderRepairsTable() {
  const tbody = document.getElementById('repairs-table-body');
  if (!tbody) return;

  const query = (document.getElementById('repairs-search')?.value || '').toLowerCase().trim();
  const filtered = REPAIRS.filter(r => {
    if (currentRepairFilter !== 'all' && r.status !== currentRepairFilter) return false;
    if (!query) return true;
    return (
      (r.order_code || '').toLowerCase().includes(query) ||
      (r.customer_name || '').toLowerCase().includes(query) ||
      (r.device_brand || '').toLowerCase().includes(query) ||
      (r.device_model || '').toLowerCase().includes(query) ||
      (r.imei_or_serial || '').toLowerCase().includes(query)
    );
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="p-8 text-center text-slate-400 font-bold">No se encontraron órdenes de servicio técnico.</td></tr>`;
    return;
  }

  const badgeColors = {
    'Recibido': 'bg-amber-100 text-amber-800',
    'En Reparación': 'bg-indigo-100 text-indigo-800',
    'Listo': 'bg-emerald-100 text-emerald-800',
    'Entregado': 'bg-slate-200 text-slate-700',
    'Cancelado': 'bg-rose-100 text-rose-700'
  };

  tbody.innerHTML = filtered.map(r => {
    const cost = parseFloat(r.estimated_cost || 0);
    const deposit = parseFloat(r.advance_payment || 0);
    const saldo = Math.max(0, cost - deposit);
    const badgeClass = badgeColors[r.status] || 'bg-slate-100 text-slate-700';
    const issueText = r.issue_description || '';

    return `
      <tr class="hover:bg-slate-50/80 transition-colors">
        <td class="p-4 font-mono-code font-bold text-indigo-700 text-xs">${r.order_code}</td>
        <td class="p-4 text-xs text-slate-500">${new Date(r.created_at).toLocaleString()}</td>
        <td class="p-4">
          <p class="font-bold text-slate-900">${r.customer_name}</p>
          <p class="text-[11px] font-mono-code text-slate-400">${r.customer_phone || '-'}</p>
        </td>
        <td class="p-4">
          <p class="font-bold text-slate-800">${r.device_brand} ${r.device_model}</p>
          ${r.imei_or_serial ? `<p class="text-[11px] font-mono-code text-slate-500">IMEI/SN: ${r.imei_or_serial}</p>` : ''}
        </td>
        <td class="p-4 text-xs text-slate-600 max-w-xs truncate" title="${issueText}">
          <p class="font-medium text-slate-800 truncate">${issueText}</p>
          ${r.diagnosis ? `<p class="text-[11px] text-indigo-600 font-semibold truncate">Diag: ${r.diagnosis}</p>` : ''}
        </td>
        <td class="p-4 text-right">
          <p class="font-mono-code tabular-nums font-black text-slate-900">Costo: S/ ${cost.toFixed(2)}</p>
          <p class="text-[11px] font-mono-code tabular-nums font-bold ${saldo > 0 ? 'text-rose-600' : 'text-emerald-700'}">Saldo: S/ ${saldo.toFixed(2)} (Adel: S/ ${deposit.toFixed(2)})</p>
        </td>
        <td class="p-4 text-center">
          <span class="px-2.5 py-1 rounded-full text-[10px] font-black ${badgeClass}">${r.status}</span>
        </td>
        <td class="p-4 text-center">
          <div class="flex items-center justify-center gap-2">
            <button onclick="openRepairUpdateModal(${r.id})" class="btn-tactile bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold px-2.5 py-1.5 rounded-xl text-xs" title="Actualizar Estado / Cobrar">
              <i class="fa-solid fa-pen-to-square mr-1"></i> Estado
            </button>
            <button onclick="reprintRepairTicket(${r.id})" class="action-icon-btn bg-slate-100 hover:bg-indigo-50 text-slate-600 hover:text-indigo-700" title="Imprimir Orden de Servicio">
              <i class="fa-solid fa-print text-xs"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function openRepairModal() {
  document.getElementById('rep-customer-name').value = '';
  document.getElementById('rep-customer-phone').value = '';
  document.getElementById('rep-brand').value = '';
  document.getElementById('rep-model').value = '';
  document.getElementById('rep-imei').value = '';
  document.getElementById('rep-pattern').value = '';
  document.getElementById('rep-diagnosis').value = '';
  document.getElementById('rep-issue').value = '';
  document.getElementById('rep-cost').value = '0.00';
  document.getElementById('rep-advance').value = '0.00';
  document.getElementById('rep-payment-method').value = 'Efectivo';
  document.getElementById('modal-repair').classList.remove('hidden');
}

function closeRepairModal() {
  document.getElementById('modal-repair').classList.add('hidden');
}

async function saveRepairOrder(e) {
  e.preventDefault();
  const payload = {
    customer_name: document.getElementById('rep-customer-name').value.trim(),
    customer_phone: document.getElementById('rep-customer-phone').value.trim(),
    device_brand: document.getElementById('rep-brand').value.trim(),
    device_model: document.getElementById('rep-model').value.trim(),
    imei_or_serial: document.getElementById('rep-imei').value.trim(),
    unlock_pattern: document.getElementById('rep-pattern').value.trim(),
    diagnosis: document.getElementById('rep-diagnosis').value.trim(),
    issue_description: document.getElementById('rep-issue').value.trim(),
    estimated_cost: parseFloat(document.getElementById('rep-cost').value) || 0,
    advance_payment: parseFloat(document.getElementById('rep-advance').value) || 0,
    payment_method: document.getElementById('rep-payment-method').value
  };

  try {
    const res = await fetch('/api/repairs', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al registrar orden');

    const created = data.order || data.repair;
    closeRepairModal();
    await loadRepairs();
    await loadCashStatus();
    await loadDashboard();
    showToast('Orden Registrada', `Orden ${created.order_code} generada.`);

    renderRepairThermalTicket(created);
    document.getElementById('modal-ticket').classList.remove('hidden');
  } catch (err) {
    alert('❌ Error: ' + err.message);
  }
}

function openRepairUpdateModal(repairId) {
  const r = REPAIRS.find(item => item.id === repairId);
  if (!r) return;

  const cost = parseFloat(r.estimated_cost || 0);
  const deposit = parseFloat(r.advance_payment || 0);
  const pending = Math.max(0, cost - deposit);

  document.getElementById('upd-rep-id').value = r.id;
  document.getElementById('upd-rep-code').innerText = `#${r.order_code}`;
  document.getElementById('upd-rep-status').value = r.status || 'Recibido';
  document.getElementById('upd-rep-diagnosis').value = r.diagnosis || '';
  document.getElementById('upd-rep-cost').value = cost.toFixed(2);
  document.getElementById('upd-rep-pending').value = `S/ ${pending.toFixed(2)}`;
  document.getElementById('upd-rep-collect').checked = false;
  document.getElementById('upd-rep-method').value = 'Efectivo';

  const collectBox = document.getElementById('upd-rep-collect-box');
  if (collectBox) {
    if (pending > 0) collectBox.classList.remove('hidden');
    else collectBox.classList.add('hidden');
  }

  document.getElementById('modal-repair-update').classList.remove('hidden');
}

function closeRepairUpdateModal() {
  document.getElementById('modal-repair-update').classList.add('hidden');
}

async function submitRepairUpdate(e) {
  e.preventDefault();
  const id = document.getElementById('upd-rep-id').value;
  const payload = {
    status: document.getElementById('upd-rep-status').value,
    diagnosis: document.getElementById('upd-rep-diagnosis').value.trim(),
    estimated_cost: parseFloat(document.getElementById('upd-rep-cost').value) || 0,
    collect_balance: document.getElementById('upd-rep-collect').checked,
    payment_method: document.getElementById('upd-rep-method').value
  };

  try {
    const res = await fetch(`/api/repairs/${id}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al actualizar orden');

    closeRepairUpdateModal();
    await loadRepairs();
    await loadCashStatus();
    await loadDashboard();
    showToast('Orden Actualizada', data.message || `Estado actualizado a ${payload.status}`);
  } catch (err) {
    alert('❌ Error: ' + err.message);
  }
}

function reprintRepairTicket(repairId) {
  const r = REPAIRS.find(item => item.id === repairId);
  if (!r) return;
  renderRepairThermalTicket(r);
  document.getElementById('modal-ticket').classList.remove('hidden');
}

function renderRepairThermalTicket(r) {
  const container = document.getElementById('thermal-ticket-container');
  if (!container) return;

  const cost = parseFloat(r.estimated_cost || 0);
  const deposit = parseFloat(r.advance_payment || 0);
  const pending = Math.max(0, cost - deposit);

  container.innerHTML = `
    <div style="text-align: center; border-bottom: 1px dashed #666; padding-bottom: 6px; margin-bottom: 6px;">
      <div style="font-size: 14px; font-weight: bold;">CELLVENTAS</div>
      <div>ORDEN DE SERVICIO TÉCNICO</div>
      <div style="margin-top: 4px; font-weight: bold; font-size: 13px;">${r.order_code}</div>
      <div style="font-size: 10px;">Fecha: ${new Date(r.created_at || Date.now()).toLocaleString()}</div>
      <div style="font-size: 11px; font-weight: bold; margin-top: 2px;">ESTADO: ${(r.status || 'Recibido').toUpperCase()}</div>
    </div>

    <div style="border-bottom: 1px dashed #666; padding-bottom: 4px; margin-bottom: 4px;">
      <div><strong>CLIENTE:</strong> ${r.customer_name}</div>
      <div><strong>TELÉFONO:</strong> ${r.customer_phone || '-'}</div>
    </div>

    <div style="border-bottom: 1px dashed #666; padding-bottom: 4px; margin-bottom: 4px;">
      <div><strong>EQUIPO:</strong> ${r.device_brand} ${r.device_model}</div>
      ${r.imei_or_serial ? `<div><strong>IMEI/SERIE:</strong> ${r.imei_or_serial}</div>` : ''}
      ${r.unlock_pattern ? `<div><strong>CLAVE/PATRÓN:</strong> ${r.unlock_pattern}</div>` : ''}
      <div style="margin-top: 3px;"><strong>FALLA REPORTADA:</strong> ${r.issue_description || ''}</div>
      ${r.diagnosis ? `<div style="margin-top: 3px;"><strong>DIAGNÓSTICO:</strong> ${r.diagnosis}</div>` : ''}
    </div>

    <div style="padding: 4px 0; border-bottom: 1px dashed #666;">
      <div style="display: flex; justify-content: space-between;">
        <span>Costo Estimado:</span>
        <span>S/ ${cost.toFixed(2)}</span>
      </div>
      <div style="display: flex; justify-content: space-between;">
        <span>Adelanto / Abonado:</span>
        <span>S/ ${deposit.toFixed(2)}</span>
      </div>
      <div style="display: flex; justify-content: space-between; font-weight: bold; font-size: 13px; margin-top: 3px;">
        <span>SALDO PENDIENTE:</span>
        <span>S/ ${pending.toFixed(2)}</span>
      </div>
    </div>

    <div style="text-align: center; margin-top: 10px; font-size: 10px;">
      <div>Conserve este ticket para recoger su equipo.</div>
      <div>Pasados 30 días de notificado, la tienda no se responsabiliza por equipos abandonados.</div>
      <div style="margin-top: 24px; border-top: 1px solid #000; width: 80%; margin-left: auto; margin-right: auto; padding-top: 4px;">
        Firma Conformidad Cliente
      </div>
    </div>
  `;
}

// ==============================================================
// 11. AUTENTICACIÓN Y CAMBIO DE ROL DE USUARIO
// ==============================================================
function updateUserSessionUI() {
  const nameEl = document.getElementById('sidebar-user-name');
  const roleEl = document.getElementById('sidebar-user-role');
  const avatarEl = document.getElementById('sidebar-user-avatar');
  const profitCard = document.getElementById('dash-profit-card');

  if (!currentUser) return;
  if (nameEl) nameEl.innerText = currentUser.name || 'Usuario';
  if (roleEl) roleEl.innerText = (currentUser.role || 'admin').toUpperCase();
  if (avatarEl) avatarEl.innerText = (currentUser.name || 'A').charAt(0).toUpperCase();

  // Ocultar utilidad bruta si el rol activo es vendedor
  if (profitCard) {
    if (currentUser.role === 'vendedor') {
      profitCard.classList.add('hidden');
    } else {
      profitCard.classList.remove('hidden');
    }
  }
}

function openLoginModal() {
  document.getElementById('login-username').value = currentUser?.username || 'admin';
  document.getElementById('login-password').value = '';
  document.getElementById('modal-login').classList.remove('hidden');
}

function closeLoginModal() {
  document.getElementById('modal-login').classList.add('hidden');
}

async function submitLogin(e) {
  e.preventDefault();
  const username = document.getElementById('login-username').value;
  const password = document.getElementById('login-password').value;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Credenciales incorrectas');

    authToken = data.token;
    currentUser = data.user;
    localStorage.setItem('cellventas_token', authToken);
    localStorage.setItem('cellventas_user', JSON.stringify(currentUser));

    updateUserSessionUI();
    closeLoginModal();
    showToast('Sesión Iniciada', `Bienvenido, ${currentUser.name} (${currentUser.role.toUpperCase()})`);
  } catch (err) {
    alert('❌ ' + err.message);
  }
}

async function handleScreenLogin(e) {
  e.preventDefault();
  const username = document.getElementById('login-screen-username').value.trim();
  const password = document.getElementById('login-screen-password').value;
  const errorEl = document.getElementById('login-screen-error');
  const errorMsg = document.getElementById('login-screen-error-msg');
  const btn = document.getElementById('login-screen-btn');

  if (errorEl) errorEl.classList.add('hidden');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Credenciales incorrectas');

    authToken = data.token;
    currentUser = data.user;
    localStorage.setItem('cellventas_token', authToken);
    localStorage.setItem('cellventas_user', JSON.stringify(currentUser));

    hideLoginScreen();
    updateUserSessionUI();
    showToast('Sesión Iniciada', `Bienvenido, ${currentUser.name} (${currentUser.role.toUpperCase()})`);

    await loadCashStatus();
    await loadCashHistory();
    await loadBrandsAndModels();
    await loadProducts();
    await loadCustomers();
    await loadRepairs();
    await loadDashboard();
    await loadCoverageData();
    await loadSalesHistory();
  } catch (err) {
    if (errorEl && errorMsg) {
      errorMsg.innerText = err.message;
      errorEl.classList.remove('hidden');
    } else {
      alert('❌ ' + err.message);
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function logout() {
  if (!confirm('¿Desea cerrar la sesión de mostrador actual?')) return;
  authToken = '';
  currentUser = null;
  localStorage.removeItem('cellventas_token');
  localStorage.removeItem('cellventas_user');
  showLoginScreen();
  showToast('Sesión Cerrada', 'Hasta pronto.', 'warning');
}

function setQuickLogin(username, password) {
  const uInput = document.getElementById('login-screen-username');
  const pInput = document.getElementById('login-screen-password');
  if (uInput) uInput.value = username;
  if (pInput) {
    pInput.value = password;
    pInput.focus();
  }
}

// ==========================================
// GESTIÓN DE USUARIOS Y SEGURIDAD DE ACCESO
// ==========================================

function openUserManagementModal() {
  const modal = document.getElementById('modal-user-management');
  if (!modal) return;

  const userDisplay = document.getElementById('modal-curr-user-display');
  const userAvatar = document.getElementById('modal-curr-user-avatar');
  if (currentUser) {
    if (userDisplay) userDisplay.innerText = `Usuario en sesión: ${currentUser.name} (@${currentUser.username}) - Rol: ${currentUser.role}`;
    if (userAvatar) userAvatar.innerText = (currentUser.name || 'U').charAt(0).toUpperCase();
  }

  const currP = document.getElementById('chg-curr-password');
  const newP = document.getElementById('chg-new-password');
  const confP = document.getElementById('chg-confirm-password');
  if (currP) currP.value = '';
  if (newP) newP.value = '';
  if (confP) confP.value = '';

  switchUserModalTab('my-security');
  modal.classList.remove('hidden');
}

function closeUserManagementModal() {
  const modal = document.getElementById('modal-user-management');
  if (modal) modal.classList.add('hidden');
}

function switchUserModalTab(tab) {
  const tabSec = document.getElementById('user-tab-my-security');
  const tabTeam = document.getElementById('user-tab-team-manage');
  const btnSec = document.getElementById('tab-btn-my-security');
  const btnTeam = document.getElementById('tab-btn-team-manage');

  if (tab === 'my-security') {
    if (tabSec) tabSec.classList.remove('hidden');
    if (tabTeam) tabTeam.classList.add('hidden');
    if (btnSec) {
      btnSec.className = 'px-4 py-2.5 border-b-2 border-indigo-600 text-indigo-600 transition-colors flex items-center gap-1.5 font-bold';
    }
    if (btnTeam) {
      btnTeam.className = 'px-4 py-2.5 border-b-2 border-transparent text-slate-500 hover:text-slate-800 transition-colors flex items-center gap-1.5 font-bold';
    }
  } else if (tab === 'team-manage') {
    if (tabSec) tabSec.classList.add('hidden');
    if (tabTeam) tabTeam.classList.remove('hidden');
    if (btnTeam) {
      btnTeam.className = 'px-4 py-2.5 border-b-2 border-indigo-600 text-indigo-600 transition-colors flex items-center gap-1.5 font-bold';
    }
    if (btnSec) {
      btnSec.className = 'px-4 py-2.5 border-b-2 border-transparent text-slate-500 hover:text-slate-800 transition-colors flex items-center gap-1.5 font-bold';
    }
    loadUsersList();
  }
}

function toggleNewUserForm() {
  const box = document.getElementById('box-new-user-form');
  if (box) box.classList.toggle('hidden');
}

async function loadUsersList() {
  const tbody = document.getElementById('users-table-body');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-slate-400 font-semibold"><i class="fa-solid fa-spinner fa-spin mr-2"></i> Cargando usuarios...</td></tr>`;

  try {
    const res = await fetch('/api/users', { headers: getAuthHeaders() });
    const users = await res.json();

    if (!Array.isArray(users) || users.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-slate-400">No hay usuarios registrados.</td></tr>`;
      return;
    }

    tbody.innerHTML = users.map(u => {
      const isCurrent = currentUser && currentUser.id === u.id;
      const isAdmin = u.role === 'Administrador';
      const roleBadge = isAdmin
        ? `<span class="bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full text-[10px] font-black">ADMIN</span>`
        : `<span class="bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full text-[10px] font-black">VENDEDOR</span>`;

      return `
        <tr class="hover:bg-slate-50/80 transition-colors">
          <td class="p-3">
            <span class="font-bold text-slate-900">${u.name}</span>
            ${isCurrent ? '<span class="text-[10px] bg-amber-100 text-amber-800 font-bold px-1.5 py-0.5 rounded ml-1.5">Tú</span>' : ''}
          </td>
          <td class="p-3 font-mono-code text-slate-600 text-xs font-semibold">@${u.username}</td>
          <td class="p-3">${roleBadge}</td>
          <td class="p-3 text-center">
            <div class="flex items-center justify-center gap-1.5">
              <button onclick="handleResetPassword(${u.id}, '${u.username}')" class="action-icon-btn bg-amber-50 text-amber-600 hover:bg-amber-100 hover:text-amber-800" title="Restablecer Clave"><i class="fa-solid fa-key text-xs"></i></button>
              ${u.username !== 'admin' && !isCurrent ? `
                <button onclick="handleDeleteUser(${u.id}, '${u.username}')" class="action-icon-btn bg-rose-50 text-rose-600 hover:bg-rose-100 hover:text-rose-800" title="Eliminar Usuario"><i class="fa-solid fa-trash text-xs"></i></button>
              ` : ''}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-rose-500">Error al cargar usuarios: ${err.message}</td></tr>`;
  }
}

async function handleChangePassword(e) {
  e.preventDefault();
  const currentPassword = document.getElementById('chg-curr-password')?.value;
  const newPassword = document.getElementById('chg-new-password')?.value;
  const confirmPassword = document.getElementById('chg-confirm-password')?.value;

  if (!currentPassword || !newPassword) {
    alert('⚠️ Ingrese su contraseña actual y la nueva contraseña.');
    return;
  }

  if (newPassword !== confirmPassword) {
    alert('⚠️ La confirmación de contraseña no coincide con la nueva contraseña.');
    return;
  }

  if (newPassword.length < 4) {
    alert('⚠️ La nueva contraseña debe tener como mínimo 4 caracteres.');
    return;
  }

  try {
    const res = await fetch('/api/auth/change-password', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify({ currentPassword, newPassword })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al actualizar contraseña.');

    alert('✅ Contraseña actualizada con éxito. Por seguridad, utilícela en su próximo inicio de sesión.');
    document.getElementById('chg-curr-password').value = '';
    document.getElementById('chg-new-password').value = '';
    document.getElementById('chg-confirm-password').value = '';
    closeUserManagementModal();
  } catch (err) {
    alert('❌ ' + err.message);
  }
}

async function handleCreateUser(e) {
  e.preventDefault();
  const name = document.getElementById('new-user-name')?.value?.trim();
  const username = document.getElementById('new-user-username')?.value?.trim();
  const role = document.getElementById('new-user-role')?.value;
  const password = document.getElementById('new-user-password')?.value;

  if (!name || !username || !password) {
    alert('⚠️ Todos los campos son obligatorios.');
    return;
  }

  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify({ name, username, role, password })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al crear usuario.');

    alert(`✅ Colaborador "@${username}" creado correctamente con rol ${role}.`);
    document.getElementById('new-user-name').value = '';
    document.getElementById('new-user-username').value = '';
    document.getElementById('new-user-password').value = '';
    toggleNewUserForm();
    await loadUsersList();
  } catch (err) {
    alert('❌ ' + err.message);
  }
}

async function handleResetPassword(userId, username) {
  const newPass = prompt(`Ingrese la nueva contraseña para el usuario "@${username}":`, '');
  if (!newPass) return;

  if (newPass.length < 4) {
    alert('⚠️ La nueva contraseña debe tener mínimo 4 caracteres.');
    return;
  }

  try {
    const res = await fetch(`/api/users/${userId}/password`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders()
      },
      body: JSON.stringify({ newPassword: newPass })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al resetear contraseña.');

    alert(`✅ Contraseña de "@${username}" actualizada con éxito.`);
  } catch (err) {
    alert('❌ ' + err.message);
  }
}

async function handleDeleteUser(userId, username) {
  if (!confirm(`¿Está seguro de eliminar al usuario "@${username}"? Ya no podrá acceder al sistema.`)) return;

  try {
    const res = await fetch(`/api/users/${userId}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al eliminar usuario.');

    alert(`✅ Usuario "@${username}" eliminado con éxito.`);
    await loadUsersList();
  } catch (err) {
    alert('❌ ' + err.message);
  }
}

window.onload = init;

