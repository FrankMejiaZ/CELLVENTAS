# CELLVENTAS by VT VALETEC - Sistema POS & Matriz de Compatibilidad para Celulares y Accesorios

Sistema especializado para tiendas de teléfonos móviles, fundas/cases, micas de vidrio templado, cargadores, repuestos y servicio técnico, con **Buscador de Compatibilidad por Modelo de Celular**, control de IMEIs y cuentas por cobrar (Fiados).

---

## 🚀 Despliegue Rápido en Docker Desktop

```bash
docker-compose up -d --build
```

### URLs de Acceso:
- **Interfaz Web (Frontend):** [http://localhost:3006](http://localhost:3006)
- **Backend API REST:** [http://localhost:8092](http://localhost:8092)
- **Base de Datos PostgreSQL:** `localhost:5434` (DB: `cellventas_db`)

---

## ✨ Funcionalidades Especializadas
1. **Filtro de Compatibilidad por Modelo de Celular en POS:**
   - Selecciona la marca (Apple, Samsung, Xiaomi, Motorola) y el modelo (ej. iPhone 15 Pro Max) para ver inmediatamente todos los accesorios compatibles.
2. **Matriz de Compatibilidad Multimodelo:**
   - Asigna uno o múltiples celulares compatibles a cada funda o mica de vidrio.
3. **Registro de IMEIs:**
   - Control de números IMEI para equipos celulares.
4. **Venta a Fiado y CRM Clientes:**
   - Saldo deudor y registro de abonos parciales.
