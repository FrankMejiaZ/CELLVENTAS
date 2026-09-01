// Global State for CELLVENTAS
let BRANDS = [];
let PRODUCTS = [];
let CLIENTS = [];
let CART = [];
let selectedPaymentMethod = 'Efectivo';

async function init() {
  await loadBrandsAndModels();
  await loadProducts();
  await loadCustomers();
  await loadDashboard();
}

function switchTab(tabId) {
  document.querySelectorAll('.view-section').forEach(el => el.classList.add('hidden'));
  const target = document.getElementById('view-' + tabId);
  if (target) target.classList.remove('hidden');

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.className = 'nav-btn w-full flex items-center gap-3 px-4 py-3 rounded-xl text-slate-400 hover:bg-slate-800 hover:text-white font-semibold transition-all';
  });
  const activeBtn = document.getElementById('btn-tab-' + tabId);
  if (activeBtn) {
    activeBtn.className = 'nav-btn w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-indigo-600 text-white font-bold transition-all shadow-md';
  }

  if (tabId === 'compatibility') renderCompatibilityMatrix();
  if (tabId === 'inventory') renderInventoryTable();
  if (tabId === 'crm') renderCRMTable();
  if (tabId === 'fiados') renderFiadosTable();
  if (tabId === 'dashboard') loadDashboard();
}

// API Loaders
async function loadBrandsAndModels() {
  try {
    const res = await fetch('/api/brands');
    BRANDS = await res.json();
    populateBrandFilters();
    populateModelCheckboxes();
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
    renderCRMTable();
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
    document.getElementById('dash-tickets').innerText = `${data.todayTickets || 0} Tickets`;
    document.getElementById('dash-total-fiado').innerText = `S/ ${(data.totalFiadosDebt || 0).toFixed(2)}`;
    document.getElementById('dash-top-product').innerText = data.topProduct || '--';
  } catch (err) {}
}

// POS & FILTROS DE COMPATIBILIDAD
function populateBrandFilters() {
  const brandSelect = document.getElementById('pos-brand-filter');
  brandSelect.innerHTML = '<option value="">-- Todas las Marcas --</option>' + 
    BRANDS.map(b => `<option value="${b.id}">${b.name}</option>`).join('');

  const modelSelect = document.getElementById('model-brand-id');
  if (modelSelect) {
    modelSelect.innerHTML = BRANDS.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
  }
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

  const filtered = PRODUCTS.filter(p => {
    // Filtro de compatibilidad por modelo de celular
    let matchModel = true;
    if (selectedModelId) {
      matchModel = p.compatible_models && p.compatible_models.some(m => String(m.model_id) === String(selectedModelId));
    }
    // Filtro de búsqueda por texto o SKU
    const matchQuery = p.name.toLowerCase().includes(query) || p.code.toLowerCase().includes(query) || p.category.toLowerCase().includes(query);
    return matchModel && matchQuery;
  });

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="col-span-full text-center py-12 text-slate-400 font-bold">No se encontraron productos ni accesorios compatibles.</div>`;
    return;
  }

  grid.innerHTML = filtered.map(p => {
    const modelBadges = (p.compatible_models || []).slice(0, 2).map(m => `
      <span class="bg-indigo-50 text-indigo-700 text-[9px] font-bold px-1.5 py-0.5 rounded border border-indigo-100">${m.model_name}</span>
    `).join('');

    return `
      <div onclick="addToCart(${p.id})" class="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-all cursor-pointer flex flex-col justify-between group">
        <div>
          <div class="flex justify-between items-start mb-2">
            <span class="bg-slate-100 text-slate-600 text-[10px] font-bold px-2 py-0.5 rounded-md truncate max-w-[100px]">${p.category}</span>
            <span class="text-[10px] font-mono text-slate-400">#${p.code}</span>
          </div>
          <h3 class="font-bold text-slate-800 text-xs group-hover:text-indigo-600 transition-colors line-clamp-2">${p.name}</h3>
          <div class="mt-2 flex flex-wrap gap-1">${modelBadges}</div>
        </div>
        <div class="mt-4 flex justify-between items-end pt-2 border-t border-slate-100">
          <div>
            <p class="text-[10px] text-slate-400 font-bold">Stock: ${p.stock}</p>
            <p class="text-base font-black text-indigo-600">S/ ${p.price.toFixed(2)}</p>
          </div>
          <button class="w-8 h-8 bg-indigo-50 text-indigo-600 rounded-xl flex items-center justify-center font-bold group-hover:bg-indigo-600 group-hover:text-white transition-all">
            <i class="fa-solid fa-plus"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// CARRITO
function addToCart(productId) {
  const prod = PRODUCTS.find(p => p.id === productId);
  if (!prod || prod.stock <= 0) {
    alert('⚠️ Producto sin stock disponible.');
    return;
  }

  const existing = CART.find(i => i.product.id === productId);
  if (existing) {
    if (existing.quantity >= prod.stock) {
      alert(`⚠️ Stock máximo alcanzado (${prod.stock} und).`);
      return;
    }
    existing.quantity += 1;
  } else {
    CART.push({ product: prod, quantity: 1 });
  }

  renderCart();
}

function updateCartQty(productId, delta) {
  const item = CART.find(i => i.product.id === productId);
  if (!item) return;

  item.quantity += delta;
  if (item.quantity <= 0) {
    CART = CART.filter(i => i.product.id !== productId);
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
    container.innerHTML = `<div class="text-center py-12 text-slate-400 font-bold text-xs">Carrito vacío</div>`;
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
    return `
      <div class="py-2.5 flex justify-between items-center gap-2">
        <div class="flex-1 min-w-0">
          <p class="font-bold text-xs text-slate-800 truncate">${i.product.name}</p>
          <p class="text-[10px] text-slate-400">S/ ${i.product.price.toFixed(2)} c/u</p>
        </div>
        <div class="flex items-center gap-1.5">
          <button onclick="updateCartQty(${i.product.id}, -1)" class="w-5 h-5 bg-slate-100 rounded text-xs font-bold">-</button>
          <span class="text-xs font-bold w-4 text-center">${i.quantity}</span>
          <button onclick="updateCartQty(${i.product.id}, 1)" class="w-5 h-5 bg-slate-100 rounded text-xs font-bold">+</button>
        </div>
        <span class="font-black text-xs text-slate-900 w-14 text-right">S/ ${itemSub.toFixed(2)}</span>
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

// PROCESAR VENTA POS
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
  document.getElementById('modal-payment').classList.remove('hidden');
}

function closePaymentModal() {
  document.getElementById('modal-payment').classList.add('hidden');
}

function setPaymentMethod(method) {
  selectedPaymentMethod = method;
  document.querySelectorAll('.pay-btn').forEach(b => {
    b.className = 'pay-btn bg-slate-100 text-slate-700 font-bold py-2 rounded-xl text-xs';
  });
  const activeBtn = document.getElementById('pay-' + method);
  if (activeBtn) activeBtn.className = 'pay-btn active bg-indigo-600 text-white font-bold py-2 rounded-xl text-xs';
}

async function processFinalSale() {
  const customerId = document.getElementById('modal-select-customer').value;
  const customerObj = CLIENTS.find(c => String(c.id) === String(customerId));
  const customerName = customerObj ? customerObj.name : 'Público General';

  if (selectedPaymentMethod === 'Fiado' && !customerId) {
    alert('⚠️ Debe seleccionar un cliente registrado para la opción de FIADO.');
    return;
  }

  const payload = {
    doc_type: 'Ticket',
    customer_id: customerId ? parseInt(customerId) : null,
    customer_name: customerName,
    payment_method: selectedPaymentMethod,
    items: CART.map(i => ({
      product_id: i.product.id,
      product_name: i.product.name,
      quantity: i.quantity,
      unit_price: i.product.price
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

    alert(`✅ Venta procesada con éxito. Código: ${data.receipt_code}`);
    closePaymentModal();
    clearCart();
    await loadProducts();
    await loadCustomers();
    await loadDashboard();
  } catch (err) {
    alert('❌ Error: ' + err.message);
  }
}

// MATRIZ DE COMPATIBILIDAD
function renderCompatibilityMatrix() {
  const container = document.getElementById('compatibility-matrix-container');
  if (BRANDS.length === 0) {
    container.innerHTML = `<div class="col-span-full text-center py-12 text-slate-400 font-bold">No hay marcas ni modelos registrados.</div>`;
    return;
  }

  container.innerHTML = BRANDS.map(b => `
    <div class="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-3">
      <div class="flex justify-between items-center pb-2 border-b border-slate-100">
        <h3 class="font-black text-indigo-900 text-base flex items-center gap-2">
          <i class="fa-solid fa-mobile text-indigo-600"></i> ${b.name}
        </h3>
        <span class="bg-indigo-50 text-indigo-700 text-xs font-bold px-2 py-0.5 rounded-full">${b.models.length} Modelos</span>
      </div>
      <div class="divide-y divide-slate-100">
        ${b.models.map(m => `
          <div class="py-2 flex justify-between items-center text-xs">
            <span class="font-bold text-slate-800"><i class="fa-solid fa-angle-right text-indigo-400 mr-1.5"></i>${m.model_name}</span>
            <span class="text-slate-400 text-[10px]">${m.release_year || 2024}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

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
    await loadBrandsAndModels();
    renderCompatibilityMatrix();
  } catch (err) { alert('❌ Error: ' + err.message); }
}

function openModelModal() { document.getElementById('modal-model').classList.remove('hidden'); }
function closeModelModal() { document.getElementById('modal-model').classList.add('hidden'); }
async function saveModel(e) {
  e.preventDefault();
  const brand_id = parseInt(document.getElementById('model-brand-id').value);
  const model_name = document.getElementById('model-name').value.trim();
  try {
    const res = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand_id, model_name })
    });
    if (!res.ok) throw new Error('Error al guardar modelo');
    closeModelModal();
    await loadBrandsAndModels();
    renderCompatibilityMatrix();
  } catch (err) { alert('❌ Error: ' + err.message); }
}

// REGISTRO DE PRODUCTO Y CHECKBOXES DE MODELOS COMPATIBLES
function populateModelCheckboxes() {
  const container = document.getElementById('product-model-checkboxes');
  if (!container) return;

  let html = '';
  BRANDS.forEach(b => {
    if (b.models && b.models.length > 0) {
      html += `<div class="col-span-full font-bold text-indigo-900 text-[10px] uppercase border-b border-indigo-100 pt-1 mt-1">${b.name}</div>`;
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

function openProductModal() { document.getElementById('modal-product').classList.remove('hidden'); }
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
    alert('✅ Accesorio guardado con sus compatibilidades vinculadas.');
  } catch (err) { alert('❌ Error: ' + err.message); }
}

// TABLES
function renderInventoryTable() {
  const tbody = document.getElementById('inventory-table-body');
  if (!tbody) return;
  tbody.innerHTML = PRODUCTS.map(p => {
    const modelsStr = (p.compatible_models || []).map(m => m.model_name).join(', ') || 'Universal';
    return `
      <tr class="hover:bg-slate-50">
        <td class="p-3 font-mono text-xs text-slate-500">${p.code}</td>
        <td class="p-3 font-bold text-slate-800 text-xs">${p.name}</td>
        <td class="p-3"><span class="bg-slate-100 text-slate-600 px-2 py-0.5 rounded text-[10px]">${p.category}</span></td>
        <td class="p-3 text-xs text-indigo-700 font-medium truncate max-w-xs">${modelsStr}</td>
        <td class="p-3 font-bold text-slate-900 text-xs">S/ ${p.price.toFixed(2)}</td>
        <td class="p-3"><span class="${p.stock < 5 ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'} px-2 py-0.5 rounded font-bold text-xs">${p.stock} und.</span></td>
        <td class="p-3 text-center">
          <button onclick="deleteProduct(${p.id})" class="text-rose-500 font-bold text-xs"><i class="fa-solid fa-trash"></i></button>
        </td>
      </tr>
    `;
  }).join('');
}

async function deleteProduct(id) {
  if (!confirm('¿Eliminar este producto?')) return;
  await fetch('/api/products/' + id, { method: 'DELETE' });
  await loadProducts();
}

function renderCRMTable() {
  const tbody = document.getElementById('crm-table-body');
  if (!tbody) return;
  tbody.innerHTML = CLIENTS.map(c => `
    <tr class="hover:bg-slate-50">
      <td class="p-3 font-mono text-xs text-slate-500">${c.doc}</td>
      <td class="p-3 font-bold text-slate-800 text-xs">${c.name}</td>
      <td class="p-3 text-xs">${c.phone || '-'}</td>
      <td class="p-3"><span class="${c.debt > 0 ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-700'} px-2 py-0.5 rounded font-bold text-xs">${c.debt > 0 ? 'Deuda: S/ ' + c.debt.toFixed(2) : 'Sin Deuda'}</span></td>
    </tr>
  `).join('');
}

function renderFiadosTable() {
  const tbody = document.getElementById('fiados-table-body');
  if (!tbody) return;
  tbody.innerHTML = CLIENTS.map(c => `
    <tr class="hover:bg-slate-50">
      <td class="p-3 font-mono text-xs text-slate-500">${c.doc}</td>
      <td class="p-3 font-bold text-slate-800 text-xs">${c.name}</td>
      <td class="p-3 text-right font-black ${c.debt > 0 ? 'text-amber-600' : 'text-slate-400'} text-xs">S/ ${c.debt.toFixed(2)}</td>
      <td class="p-3 text-center"><button onclick="registerAbono(${c.id})" class="bg-amber-500 text-white font-bold px-2.5 py-1 rounded text-xs shadow-sm">Abonar</button></td>
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
