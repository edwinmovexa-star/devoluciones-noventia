import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import {
  getFirestore, collection, addDoc, doc, updateDoc, getDoc, onSnapshot,
  serverTimestamp, query, orderBy, arrayUnion
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  BrowserMultiFormatReader
} from "https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm";
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);

const $ = selector => document.querySelector(selector);
const lista = $("#listaSurtidos");
const modalSurtido = $("#modalSurtido");
const modalDetalle = $("#modalDetalle");
const modalDevolucion = $("#modalDevolucion");
const modalPago = $("#modalPago");
const modalCaja = $("#modalCaja");

let surtidos = [];
let productosNuevo = [];
let surtidoActual = null;
let movimientosCajaActuales = [];
let catalogoProductos = new Map();
let catalogoCargado = false;
let usuarioActual = null;
let perfilActual = null;
let cancelarEscuchaSurtidos = null;
let lectorCodigo = null;
let controlesEscaner = null;
let escanerActivo = false;

const ESTADOS = {
  EN_PROCESO: "En proceso",
  CLASIFICADO: "Clasificado",
  ENVIADO: "Enviado",
  CON_REPARTIDOR: "Ingresado a punto de venta",
  ENTREGADO: "Entregado",
  FINALIZADO: "Finalizado",
  CANCELADO: "Cancelado",
  CON_DEVOLUCION: "Pendiente de registrar devolución"
};

function escapeHtml(valor = "") {
  return String(valor).replace(/[&<>"']/g, c => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;"
  })[c]);
}

function moneda(valor) {
  return Number(valor || 0).toLocaleString("es-MX", {
    style: "currency", currency: "MXN"
  });
}

function fechaSoloDia(fecha = new Date()) {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, "0");
  const d = String(fecha.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function fechaLocal(valor) {
  if (!valor) return "Sin fecha";
  const fecha = valor.toDate ? valor.toDate() : new Date(valor);
  return fecha.toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
}

function fechaPedidoTexto(s) {
  if (s.fechaPedido) {
    const [y, m, d] = s.fechaPedido.split("-");
    return `${d}/${m}/${y}`;
  }
  return fechaLocal(s.creadoEn);
}

function hoyMismo(s) {
  return s.fechaPedido === fechaSoloDia() || (!s.fechaPedido && s.creadoEn &&
    (s.creadoEn.toDate ? s.creadoEn.toDate() : new Date(s.creadoEn)).toDateString() === new Date().toDateString());
}

function textoEstado(estado) {
  return ESTADOS[estado] || estado || "Sin estado";
}

function textoPago(pago) {
  return pago === "PENDIENTE" ? "Pendiente de pago" : pago === "APARTADO" ? "Apartado" : pago === "PAGADO" ? "Pagado" : "Sin definir";
}

function establecerCargaModal(modal, activo, texto = "Guardando cambios…") {
  if (!modal) return;
  let capa = modal.querySelector(".modal-loading-layer");

  if (!capa) {
    capa = document.createElement("div");
    capa.className = "modal-loading-layer hidden";
    capa.innerHTML = `
      <div class="modal-loading-box">
        <span class="loading-spinner" aria-hidden="true"></span>
        <strong class="modal-loading-text"></strong>
      </div>`;
    modal.appendChild(capa);
  }

  capa.querySelector(".modal-loading-text").textContent = texto;
  capa.classList.toggle("hidden", !activo);
  modal.classList.toggle("is-loading", activo);

  for (const control of modal.querySelectorAll("button, input, select, textarea")) {
    if (activo) {
      control.dataset.disabledBeforeLoading = control.disabled ? "1" : "0";
      control.disabled = true;
    } else if (control.dataset.disabledBeforeLoading !== undefined) {
      control.disabled = control.dataset.disabledBeforeLoading === "1";
      delete control.dataset.disabledBeforeLoading;
    }
  }
}

function mostrarResultadoModal(modal, texto) {
  if (!modal) return;
  let aviso = modal.querySelector(".modal-result-message");
  if (!aviso) {
    aviso = document.createElement("div");
    aviso.className = "modal-result-message hidden";
    const header = modal.querySelector(".dialog-header");
    if (header) header.insertAdjacentElement("afterend", aviso);
    else modal.prepend(aviso);
  }
  aviso.textContent = texto;
  aviso.classList.remove("hidden");
  clearTimeout(aviso._hideTimer);
  aviso._hideTimer = setTimeout(() => aviso.classList.add("hidden"), 3000);
}

function totalPiezas(productos = []) {
  return productos.reduce((sum, p) => sum + Number(p.cantidad || 0), 0);
}

function totalPedido(productos = []) {
  return productos.reduce((sum, p) => sum + Number(p.cantidad || 0) * Number(p.costo || 0), 0);
}


function metodoPagoTexto(metodo) {
  return metodo === "EFECTIVO" ? "Efectivo" :
    metodo === "TRANSFERENCIA" ? "Transferencia" : "No registrado";
}

function pagosPedido(s) {
  if (Array.isArray(s.pagos)) return s.pagos;
  // Compatibilidad con pedidos creados antes de esta versión.
  if (Number(s.montoApartado || 0) > 0) {
    return [{
      id: "pago-anterior",
      monto: Number(s.montoApartado || 0),
      metodo: s.metodoPago || "",
      fecha: s.fechaPago || s.fechaPedido || ""
    }];
  }
  return [];
}

function totalPagado(s) {
  return pagosPedido(s).reduce((sum, pago) => sum + Number(pago.monto || 0), 0);
}


function tieneProductosDisponiblesParaDevolver(s) {
  return (s?.productos || []).some(producto => {
    const yaDevuelto = (s?.devoluciones || []).reduce((total, devolucion) => {
      const encontrado = (devolucion.productos || [])
        .find(item => item.idLinea === producto.idLinea);
      return total + Number(encontrado?.cantidadDevuelta || 0);
    }, 0);

    return Math.max(0, Number(producto.cantidad || 0) - yaDevuelto) > 0;
  });
}

function importeDevoluciones(s) {
  return (s.devoluciones || []).reduce((total, devolucion) => {
    if (Number.isFinite(Number(devolucion.importeAjuste))) {
      return total + Number(devolucion.importeAjuste);
    }
    return total + (devolucion.productos || []).reduce((sum, producto) =>
      sum + Number(producto.cantidadDevuelta || 0) * Number(producto.costo || 0), 0);
  }, 0);
}


function devolucionesPendientesRevision(s) {
  return (s?.devoluciones || []).filter(devolucion => {
    const estado = devolucion.estatusRevision || "PENDIENTE_SISTEMA";
    return estado !== "REGISTRADA_SISTEMA";
  });
}

function tieneDevolucionesPendientesRevision(s) {
  return devolucionesPendientesRevision(s).length > 0;
}

function textoEstatusRevision(valor) {
  return valor === "REGISTRADA_SISTEMA"
    ? "Registrada en el sistema"
    : "Pendiente de registrar en el sistema";
}

function totalAjustadoPedido(s) {
  const totalOriginal = Number(s.total || totalPedido(s.productos));
  return Math.max(0, totalOriginal - importeDevoluciones(s));
}

function saldoPendiente(s) {
  return Math.max(0, totalAjustadoPedido(s) - totalPagado(s));
}

function saldoFavor(s) {
  return Math.max(0, totalPagado(s) - totalAjustadoPedido(s));
}

function estatusPagoCalculado(s) {
  const pagado = totalPagado(s);
  const ajustado = totalAjustadoPedido(s);

  if (ajustado <= 0.009) return "PAGADO";
  if (pagado <= 0) return "PENDIENTE";
  if (pagado >= ajustado) return "PAGADO";
  return "APARTADO";
}

function fechaDesdeTexto(fechaTexto) {
  if (!fechaTexto) return null;
  const partes = String(fechaTexto).split("-").map(Number);
  if (partes.length !== 3 || partes.some(Number.isNaN)) return null;
  return new Date(partes[0], partes[1] - 1, partes[2], 0, 0, 0, 0);
}

function diasDesdeFecha(fechaTexto) {
  const inicio = fechaDesdeTexto(fechaTexto);
  if (!inicio) return 0;
  const hoy = fechaDesdeTexto(fechaSoloDia());
  return Math.floor((hoy - inicio) / 86400000);
}

function apartadoVencido(s) {
  if (s.tipoOperacion === "VR" || s.estado === "FINALIZADO") return false;

  return s.estatusPago === "APARTADO" &&
    saldoPendiente(s) > 0 &&
    diasDesdeFecha(s.fechaPedido) > 15;
}

function textoVencimiento(s) {
  if (s.tipoOperacion === "VR" || s.estado === "FINALIZADO") return "";
  if (s.estatusPago !== "APARTADO" || saldoPendiente(s) <= 0) return "";
  const dias = diasDesdeFecha(s.fechaPedido);
  if (dias > 15) return `Vencido hace ${dias - 15} día(s)`;
  if (dias === 15) return "Vence hoy";
  return `Quedan ${15 - dias} día(s)`;
}

async function cancelarApartadosVencidos() {
  const vencidos = surtidos.filter(s =>
    apartadoVencido(s) &&
    !["CANCELADO", "FINALIZADO"].includes(s.estado) &&
    s.motivoCancelacion !== "APARTADO_VENCIDO"
  );

  for (const s of vencidos) {
    try {
      const dineroAportado = totalPagado(s);

      await updateDoc(doc(db, "surtidos", s.idFirestore), {
        estado: "FINALIZADO",
        cancelado: true,
        motivoCancelacion: "APARTADO_VENCIDO",
        fechaCancelacion: fechaSoloDia(),
        reversoCajaCancelacion: dineroAportado > 0,
        saldoFavorCancelacion: dineroAportado,
        devolucionInventarioPendiente: false,
        productosRegresadosInventario: false,
        canceladoEn: serverTimestamp(),
        finalizadoEn: serverTimestamp(),
        actualizadoEn: serverTimestamp(),
        historial: arrayUnion({
          tipo: "CANCELACION_AUTOMATICA",
          detalle: dineroAportado > 0
            ? `Pedido cancelado y finalizado automáticamente por superar los 15 días. Salida de caja: ${moneda(dineroAportado)}.`
            : "Pedido cancelado y finalizado automáticamente por superar los 15 días. Sin dinero recibido.",
          fechaISO: new Date().toISOString()
        })
      });
    } catch (error) {
      console.error("No se pudo cancelar el apartado vencido:", s.folio, error);
    }
  }
}


function fechaISOValida(fecha) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ""));
}

function inicioSemanaDesdeValor(valorSemana) {
  if (!/^\d{4}-W\d{2}$/.test(valorSemana || "")) return null;
  const [anioTexto, semanaTexto] = valorSemana.split("-W");
  const anio = Number(anioTexto);
  const semana = Number(semanaTexto);
  const cuatroEnero = new Date(anio, 0, 4);
  const dia = cuatroEnero.getDay() || 7;
  const lunesSemanaUno = new Date(anio, 0, 4 - dia + 1);
  const inicio = new Date(lunesSemanaUno);
  inicio.setDate(lunesSemanaUno.getDate() + (semana - 1) * 7);
  inicio.setHours(0, 0, 0, 0);
  return inicio;
}

function fechaEnRango(fechaTexto, inicio, fin) {
  const fecha = fechaDesdeTexto(fechaTexto);
  return fecha && fecha >= inicio && fecha <= fin;
}

function rangoCajaSeleccionado() {
  const periodo = $("#periodoCaja").value;

  if (periodo === "DIA") {
    const valor = $("#fechaCaja").value;
    const fecha = fechaDesdeTexto(valor);
    if (!fecha) return null;
    const fin = new Date(fecha);
    fin.setHours(23, 59, 59, 999);
    return { inicio: fecha, fin, etiqueta: valor };
  }

  if (periodo === "SEMANA") {
    const valor = $("#semanaCaja").value;
    const inicio = inicioSemanaDesdeValor(valor);
    if (!inicio) return null;
    const fin = new Date(inicio);
    fin.setDate(fin.getDate() + 6);
    fin.setHours(23, 59, 59, 999);
    return { inicio, fin, etiqueta: valor };
  }

  const valor = $("#mesCaja").value;
  if (!/^\d{4}-\d{2}$/.test(valor || "")) return null;
  const [anio, mes] = valor.split("-").map(Number);
  const inicio = new Date(anio, mes - 1, 1);
  const fin = new Date(anio, mes, 0, 23, 59, 59, 999);
  return { inicio, fin, etiqueta: valor };
}

function todosLosMovimientosCaja() {
  const movimientos = [];

  for (const pedido of surtidos) {
    for (const pago of pagosPedido(pedido)) {
      if (!fechaISOValida(pago.fecha)) continue;

      movimientos.push({
        tipo: "INGRESO",
        fecha: pago.fecha,
        folio: pedido.folio || "",
        cliente: pedido.nombreCliente || "",
        metodo: pago.metodo || "",
        importe: Number(pago.monto || 0),
        vendedor: pedido.vendedor || "",
        responsable: pedido.responsable || "",
        ubicacion: pedido.ubicacion || "",
        estadoPedido: textoEstado(pedido.estado),
        estatusPago: textoPago(pedido.estatusPago),
        concepto: "Pago recibido"
      });
    }

    for (const devolucion of pedido.devoluciones || []) {
      const fecha = devolucion.fecha || String(devolucion.fechaISO || "").slice(0, 10);
      if (!fechaISOValida(fecha)) continue;

      movimientos.push({
        tipo: "DEVOLUCION",
        fecha,
        folio: pedido.folio || "",
        cliente: pedido.nombreCliente || "",
        metodo: "DEVOLUCION",
        importe: -Math.abs(Number(devolucion.importeAjuste || 0)),
        vendedor: pedido.vendedor || "",
        responsable: pedido.responsable || "",
        ubicacion: pedido.ubicacion || "",
        estadoPedido: textoEstado(pedido.estado),
        estatusPago: textoPago(pedido.estatusPago),
        concepto: devolucion.motivo || "Devolución"
      });
    }

    const importeCancelacion = Number(
      pedido.saldoFavorCancelacion ??
      (
        pedido.reversoCajaCancelacion
          ? totalPagado(pedido)
          : 0
      )
    );

    if (
      pedido.reversoCajaCancelacion &&
      importeCancelacion > 0 &&
      fechaISOValida(pedido.fechaCancelacion)
    ) {
      movimientos.push({
        tipo: "CANCELACION",
        fecha: pedido.fechaCancelacion,
        folio: pedido.folio || "",
        cliente: pedido.nombreCliente || "",
        metodo: "CANCELACION",
        importe: -Math.abs(importeCancelacion),
        vendedor: pedido.vendedor || "",
        responsable: pedido.responsable || "",
        ubicacion: pedido.ubicacion || "",
        estadoPedido: textoEstado(pedido.estado),
        estatusPago: textoPago(pedido.estatusPago),
        concepto: pedido.motivoCancelacion === "APARTADO_VENCIDO"
          ? "Cancelación por falta de liquidación"
          : "Cancelación de pedido"
      });
    }
  }

  return movimientos.sort((a, b) =>
    b.fecha.localeCompare(a.fecha) || b.folio.localeCompare(a.folio)
  );
}

function actualizarCamposPeriodoCaja() {
  const periodo = $("#periodoCaja").value;
  $("#campoFechaCaja").classList.toggle("hidden", periodo !== "DIA");
  $("#campoSemanaCaja").classList.toggle("hidden", periodo !== "SEMANA");
  $("#campoMesCaja").classList.toggle("hidden", periodo !== "MES");
}

function consultarCaja() {
  const rango = rangoCajaSeleccionado();
  if (!rango) {
    alert("Selecciona un periodo válido.");
    return;
  }

  const metodo = $("#metodoCaja").value;
  movimientosCajaActuales = todosLosMovimientosCaja().filter(movimiento =>
    fechaEnRango(movimiento.fecha, rango.inicio, rango.fin) &&
    (!metodo || movimiento.metodo === metodo)
  );

  const efectivo = movimientosCajaActuales
    .filter(m => m.tipo === "INGRESO" && m.metodo === "EFECTIVO")
    .reduce((sum, m) => sum + m.importe, 0);

  const transferencia = movimientosCajaActuales
    .filter(m => m.tipo === "INGRESO" && m.metodo === "TRANSFERENCIA")
    .reduce((sum, m) => sum + m.importe, 0);

  const ingresos = movimientosCajaActuales
    .filter(m => m.tipo === "INGRESO")
    .reduce((sum, m) => sum + m.importe, 0);

  const devoluciones = Math.abs(
    movimientosCajaActuales
      .filter(m => ["DEVOLUCION", "CANCELACION"].includes(m.tipo))
      .reduce((sum, m) => sum + m.importe, 0)
  );

  const neto = ingresos - devoluciones;

  $("#cajaTotal").textContent = moneda(ingresos);
  $("#cajaDevoluciones").textContent = moneda(devoluciones);
  $("#cajaNeto").textContent = moneda(neto);
  $("#cajaEfectivo").textContent = moneda(efectivo);
  $("#cajaTransferencia").textContent = moneda(transferencia);
  $("#cajaMovimientos").textContent = movimientosCajaActuales.length;

  const tbody = $("#tablaCaja");
  tbody.innerHTML = "";
  $("#sinMovimientosCaja").classList.toggle("hidden", movimientosCajaActuales.length > 0);

  for (const movimiento of movimientosCajaActuales) {
    const fila = document.createElement("tr");
    fila.innerHTML = `
      <td>${escapeHtml(movimiento.fecha)}</td>
      <td>${escapeHtml(movimiento.folio)}</td>
      <td>${escapeHtml(movimiento.cliente)}</td>
      <td><span class="movement-type ${movimiento.tipo.toLowerCase()}">${
        movimiento.tipo === "DEVOLUCION"
          ? "Devolución"
          : movimiento.tipo === "CANCELACION"
            ? "Cancelación"
            : "Ingreso"
      }</span></td>
      <td>${escapeHtml(
        movimiento.tipo === "INGRESO"
          ? metodoPagoTexto(movimiento.metodo)
          : movimiento.concepto
      )}</td>
      <td class="money-cell ${movimiento.tipo !== "INGRESO" ? "return-amount" : ""}">${moneda(movimiento.importe)}</td>
      <td>${escapeHtml(movimiento.vendedor)}</td>
    `;
    tbody.appendChild(fila);
  }
}

function abrirReporteCaja() {
  if (perfilActual?.rol !== "admin") return alert("Solo el administrador puede consultar la caja.");
  const hoy = fechaSoloDia();
  $("#fechaCaja").value = hoy;
  $("#mesCaja").value = hoy.slice(0, 7);

  const fechaHoy = new Date();
  const fechaTemporal = new Date(Date.UTC(
    fechaHoy.getFullYear(),
    fechaHoy.getMonth(),
    fechaHoy.getDate()
  ));
  const numeroDia = fechaTemporal.getUTCDay() || 7;
  fechaTemporal.setUTCDate(fechaTemporal.getUTCDate() + 4 - numeroDia);
  const inicioAnio = new Date(Date.UTC(fechaTemporal.getUTCFullYear(), 0, 1));
  const numeroSemana = Math.ceil((((fechaTemporal - inicioAnio) / 86400000) + 1) / 7);
  $("#semanaCaja").value = `${fechaTemporal.getUTCFullYear()}-W${String(numeroSemana).padStart(2, "0")}`;

  $("#periodoCaja").value = "DIA";
  $("#metodoCaja").value = "";
  actualizarCamposPeriodoCaja();
  consultarCaja();
  modalCaja.showModal();
}

function exportarCaja() {
  if (!movimientosCajaActuales.length) {
    alert("No hay movimientos para exportar.");
    return;
  }

  const filas = movimientosCajaActuales.map(m => ({
    Fecha: m.fecha,
    Folio: m.folio,
    Cliente: m.cliente,
    Tipo: m.tipo === "DEVOLUCION"
      ? "Devolución"
      : m.tipo === "CANCELACION"
        ? "Cancelación"
        : "Ingreso",
    Concepto: m.tipo === "INGRESO" ? metodoPagoTexto(m.metodo) : m.concepto,
    Método: m.tipo === "INGRESO" ? metodoPagoTexto(m.metodo) : "",
    Importe: m.importe,
    Vendedor: m.vendedor,
    Responsable: m.responsable,
    Ubicación: m.ubicacion,
    "Estado del pedido": m.estadoPedido,
    "Estatus de pago": m.estatusPago
  }));

  const efectivo = movimientosCajaActuales
    .filter(m => m.tipo === "INGRESO" && m.metodo === "EFECTIVO")
    .reduce((sum, m) => sum + m.importe, 0);
  const transferencia = movimientosCajaActuales
    .filter(m => m.tipo === "INGRESO" && m.metodo === "TRANSFERENCIA")
    .reduce((sum, m) => sum + m.importe, 0);
  const ingresos = efectivo + transferencia;
  const devoluciones = Math.abs(
    movimientosCajaActuales
      .filter(m => ["DEVOLUCION", "CANCELACION"].includes(m.tipo))
      .reduce((sum, m) => sum + m.importe, 0)
  );
  const neto = ingresos - devoluciones;

  const resumen = [
    { Concepto: "Ingresos", Importe: ingresos },
    { Concepto: "Salidas y ajustes", Importe: devoluciones },
    { Concepto: "Neto de caja", Importe: neto },
    { Concepto: "Efectivo", Importe: efectivo },
    { Concepto: "Transferencia", Importe: transferencia },
    { Concepto: "Número de movimientos", Importe: movimientosCajaActuales.length }
  ];

  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(resumen), "Resumen");
  XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filas), "Movimientos");
  XLSX.writeFile(libro, `reporte-caja-${fechaSoloDia()}.xlsx`);
}

function imprimirCaja() {
  if (!movimientosCajaActuales.length) {
    alert("No hay movimientos para imprimir.");
    return;
  }

  const efectivo = movimientosCajaActuales
    .filter(m => m.tipo === "INGRESO" && m.metodo === "EFECTIVO")
    .reduce((sum, m) => sum + m.importe, 0);
  const transferencia = movimientosCajaActuales
    .filter(m => m.tipo === "INGRESO" && m.metodo === "TRANSFERENCIA")
    .reduce((sum, m) => sum + m.importe, 0);
  const ingresos = efectivo + transferencia;
  const devoluciones = Math.abs(
    movimientosCajaActuales
      .filter(m => ["DEVOLUCION", "CANCELACION"].includes(m.tipo))
      .reduce((sum, m) => sum + m.importe, 0)
  );
  const neto = ingresos - devoluciones;

  const filas = movimientosCajaActuales.map(m => `
    <tr>
      <td>${escapeHtml(m.fecha)}</td>
      <td>${escapeHtml(m.folio)}</td>
      <td>${escapeHtml(m.cliente)}</td>
      <td>${m.tipo === "DEVOLUCION" ? "Devolución" : m.tipo === "CANCELACION" ? "Cancelación" : "Ingreso"}</td>
      <td>${escapeHtml(m.tipo === "INGRESO" ? metodoPagoTexto(m.metodo) : m.concepto)}</td>
      <td style="text-align:right">${moneda(m.importe)}</td>
    </tr>
  `).join("");

  const ventana = window.open("", "_blank", "width=900,height=700");
  if (!ventana) {
    alert("Permite las ventanas emergentes para imprimir.");
    return;
  }

  ventana.document.write(`
    <!doctype html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>Reporte de caja</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 24px; color: #111; }
        h1 { margin-bottom: 4px; }
        .summary { display: flex; gap: 24px; margin: 20px 0; }
        .summary div { border: 1px solid #bbb; padding: 12px; min-width: 150px; }
        .summary small { display:block; color:#555; }
        table { width:100%; border-collapse:collapse; }
        th, td { border:1px solid #bbb; padding:7px; font-size:12px; text-align:left; }
        th { background:#eee; }
        @media print { button { display:none; } }
      </style>
    </head>
    <body>
      <h1>Reporte de caja</h1>
      <p>Generado: ${new Date().toLocaleString("es-MX")}</p>
      <div class="summary">
        <div><small>Ingresos</small><strong>${moneda(ingresos)}</strong></div>
        <div><small>Salidas y ajustes</small><strong>${moneda(devoluciones)}</strong></div>
        <div><small>Neto</small><strong>${moneda(neto)}</strong></div>
        <div><small>Efectivo</small><strong>${moneda(efectivo)}</strong></div>
        <div><small>Transferencia</small><strong>${moneda(transferencia)}</strong></div>
        <div><small>Movimientos</small><strong>${movimientosCajaActuales.length}</strong></div>
      </div>
      <table>
        <thead><tr><th>Fecha</th><th>Folio</th><th>Cliente</th><th>Tipo</th><th>Concepto/Método</th><th>Importe</th></tr></thead>
        <tbody>${filas}</tbody>
      </table>
      <script>
        window.onload = () => setTimeout(() => window.print(), 250);
      </script>
    </body>
    </html>
  `);
  ventana.document.close();
}


function limpiarClaveProducto(valor) {
  // Se conserva como texto para no perder ceros iniciales.
  return String(valor ?? "").trim();
}

function esDispositivoMovil() {
  const navegadorMovil =
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

  const pantallaTactil =
    navigator.maxTouchPoints > 0 &&
    window.matchMedia("(max-width: 1024px)").matches;

  return navegadorMovil || pantallaTactil;
}

function actualizarMensajeEscaner(mensaje, tipo = "") {
  const elemento = $("#mensajeEscaner");

  if (!elemento) return;

  elemento.textContent = mensaje;
  elemento.className = `scanner-message ${tipo}`.trim();
}

function vibrarLecturaCorrecta() {
  if ("vibrate" in navigator) {
    navigator.vibrate(150);
  }
}

async function detenerEscaner() {
  escanerActivo = false;

  try {
    if (controlesEscaner) {
      controlesEscaner.stop();
      controlesEscaner = null;
    }
  } catch (error) {
    console.warn("No fue posible detener los controles del escáner:", error);
  }

  const video = $("#videoEscaner");

  if (video?.srcObject) {
    video.srcObject.getTracks().forEach(track => track.stop());
    video.srcObject = null;
  }

  lectorCodigo = null;
}

async function cerrarEscaner() {
  await detenerEscaner();

  const modal = $("#modalEscaner");

  if (modal?.open) {
    modal.close();
  }
}

async function procesarCodigoEscaneado(codigo) {
  const clave = limpiarClaveProducto(codigo);

  if (!clave) return;

  vibrarLecturaCorrecta();

  actualizarMensajeEscaner(
    `Código detectado: ${clave}`,
    "success"
  );

  const campoClave = $("#productoClave");

  if (!campoClave) {
    await cerrarEscaner();
    console.error("No se encontró el campo productoClave.");
    return;
  }

  campoClave.value = clave;

  await cerrarEscaner();

  const producto = buscarProductoCatalogo({
    enfocarSiguiente: true
  });

  if (!producto) {
    $("#productoNombre")?.focus();
  }
}

async function iniciarEscaner() {
  const modal = $("#modalEscaner");
  const video = $("#videoEscaner");

  if (!modal || !video) {
    alert("No se encontró la ventana del escáner.");
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    alert(
      "Este navegador no permite acceder a la cámara. " +
      "Abre el sistema desde Chrome o Safari usando HTTPS."
    );
    return;
  }

  if (escanerActivo) return;

  escanerActivo = true;
  actualizarMensajeEscaner("Solicitando acceso a la cámara…");

  modal.showModal();

  try {
    lectorCodigo = new BrowserMultiFormatReader();

    const dispositivos =
      await BrowserMultiFormatReader.listVideoInputDevices();

    if (!dispositivos.length) {
      throw new Error("No se encontró ninguna cámara disponible.");
    }

    let camaraSeleccionada = dispositivos.find(dispositivo => {
      const nombre = dispositivo.label.toLowerCase();

      return (
        nombre.includes("back") ||
        nombre.includes("rear") ||
        nombre.includes("trasera") ||
        nombre.includes("environment")
      );
    });

    if (!camaraSeleccionada) {
      camaraSeleccionada =
        dispositivos[dispositivos.length - 1];
    }

    actualizarMensajeEscaner(
      "Apunta la cámara al código de barras."
    );

    controlesEscaner =
      await lectorCodigo.decodeFromVideoDevice(
        camaraSeleccionada.deviceId,
        video,
        async (resultado, error) => {
          if (!escanerActivo) return;

          if (resultado) {
            escanerActivo = false;

            const codigo = resultado.getText();

            await procesarCodigoEscaneado(codigo);
            return;
          }

          if (error) {
            console.warn(error);
          }
        }
      );

  } catch (error) {
    console.error("Error al iniciar la cámara:", error);

    await detenerEscaner();

    let mensaje =
      "No se pudo abrir la cámara. Revisa los permisos del navegador.";

    if (error.name === "NotAllowedError") {
      mensaje =
        "El permiso de la cámara fue rechazado. " +
        "Actívalo en la configuración del navegador.";
    }

    if (error.name === "NotFoundError") {
      mensaje =
        "No se encontró una cámara disponible en este dispositivo.";
    }

    actualizarMensajeEscaner(mensaje, "error");
  }
}

function configurarEscanerMovil() {
  const boton = $("#btnEscanearCodigo");

  if (!boton) return;

  boton.classList.toggle(
    "visible",
    esDispositivoMovil()
  );
}  

function valorCampoProducto(producto, nombres) {
  for (const nombre of nombres) {
    if (producto && producto[nombre] !== undefined && producto[nombre] !== null) {
      const valor = String(producto[nombre]).trim();
      if (valor) return valor;
    }
  }
  return "";
}

function normalizarProductoCatalogo(producto) {
  const clave = limpiarClaveProducto(valorCampoProducto(producto, [
    "clave", "Clave", "CLAVE",
    "sku", "SKU", "Sku",
    "codigo", "Código", "Codigo", "CODIGO",
    "code", "Code"
  ]));

  const nombre = valorCampoProducto(producto, [
    "descripcion", "Descripción", "Descripcion", "DESCRIPCION",
    "nombre", "Nombre", "NOMBRE",
    "producto", "Producto", "PRODUCTO",
    "title", "Title"
  ]);

  const categoria = valorCampoProducto(producto, [
    "categoria", "Categoría", "Categoria", "CATEGORIA"
  ]);

  const ubicacion = valorCampoProducto(producto, [
    "ubicacion", "Ubicación", "Ubicacion", "UBICACION"
  ]);

  const costoTexto = valorCampoProducto(producto, [
    "costo", "Costo", "COSTO",
    "precio", "Precio", "PRECIO"
  ]);

  const costo = Number(String(costoTexto).replace(/[$,\s]/g, ""));

  return {
    clave,
    nombre,
    categoria,
    ubicacion,
    costo: Number.isFinite(costo) && costo > 0 ? costo : null
  };
}

function actualizarEstadoCatalogo(tipo, texto) {
  const elemento = $("#estadoCatalogo");
  if (!elemento) return;
  elemento.className = `catalog-status ${tipo}`;
  elemento.textContent = texto;
}

async function cargarCatalogoProductos() {
  actualizarEstadoCatalogo("loading", "Cargando catálogo…");

  try {
    const respuesta = await fetch("./inventario.json", { cache: "no-store" });

    if (!respuesta.ok) {
      throw new Error(`HTTP ${respuesta.status}`);
    }

    const contenido = await respuesta.json();
    const lista = Array.isArray(contenido)
      ? contenido
      : Array.isArray(contenido.productos)
        ? contenido.productos
        : Array.isArray(contenido.inventario)
          ? contenido.inventario
          : [];

    const indice = new Map();

    for (const registro of lista) {
      const producto = normalizarProductoCatalogo(registro);
      if (!producto.clave) continue;

      // Si hay claves duplicadas, conserva el primer registro válido.
      if (!indice.has(producto.clave)) {
        indice.set(producto.clave, producto);
      }
    }

    catalogoProductos = indice;
    catalogoCargado = true;

    if (catalogoProductos.size === 0) {
      actualizarEstadoCatalogo("warning", "Catálogo vacío");
    } else {
      actualizarEstadoCatalogo(
        "success",
        `${catalogoProductos.size.toLocaleString("es-MX")} productos cargados`
      );
    }
  } catch (error) {
    catalogoCargado = false;
    catalogoProductos = new Map();
    actualizarEstadoCatalogo("error", "No se cargó inventario.json");
    console.error("Error al cargar inventario.json:", error);
  }
}

function mostrarMensajeProducto(texto = "", tipo = "") {
  const elemento = $("#mensajeProducto");
  if (!elemento) return;
  elemento.textContent = texto;
  elemento.className = `product-message ${tipo}`.trim();
}

function buscarProductoCatalogo({ enfocarSiguiente = false } = {}) {
  const campoClave = $("#productoClave");
  const clave = limpiarClaveProducto(campoClave.value);
  campoClave.value = clave;

  if (!clave) {
    $("#productoNombre").value = "";
    mostrarMensajeProducto("");
    return null;
  }

  if (!catalogoCargado) {
    mostrarMensajeProducto(
      "El catálogo todavía no está disponible. Puedes escribir el nombre manualmente.",
      "warning"
    );
    return null;
  }

  const producto = catalogoProductos.get(clave);

  if (!producto) {
    $("#productoNombre").value = "";
    mostrarMensajeProducto(
      "La clave no está en el catálogo. Puedes capturar el nombre manualmente.",
      "not-found"
    );
    $("#productoNombre")?.focus();
    return null;
  }

  $("#productoNombre").value = producto.nombre || "";

  if (producto.costo && !$("#productoCosto").value) {
    $("#productoCosto").value = producto.costo;
  }

  mostrarMensajeProducto(`Producto encontrado: ${producto.nombre}`, "found");

  if (enfocarSiguiente) {
    if (!$("#productoCosto").value) {
      $("#productoCosto")?.focus();
    } else {
      $("#productoCantidad")?.focus();
      $("#productoCantidad").select();
    }
  }

  return producto;
}

function manejarLecturaCodigo(event) {
  if (event.key !== "Enter") return;

  event.preventDefault();
  event.stopPropagation();

  const producto = buscarProductoCatalogo({ enfocarSiguiente: true });

  // No agrega automáticamente la fila porque todavía puede faltar costo o cantidad.
  // El lector completa la clave y el nombre; después el usuario confirma con Agregar.
  return producto;
}

function siguienteFolio(tipo) {
  const hoy = fechaSoloDia().replaceAll("-", "");
  const consecutivo = Date.now().toString().slice(-5);
  return `${tipo}-${hoy}-${consecutivo}`;
}

function transicionesPermitidas(estadoActual) {
  const mapa = {
    EN_PROCESO: ["ENVIADO", "CANCELADO"],
    CLASIFICADO: ["ENTREGADO", "FINALIZADO", "CANCELADO"],
    ENVIADO: ["CON_REPARTIDOR", "CANCELADO"],
    CON_REPARTIDOR: ["ENTREGADO", "CANCELADO"],
    ENTREGADO: ["FINALIZADO"],
    CON_DEVOLUCION: ["FINALIZADO"],
    FINALIZADO: [],
    CANCELADO: ["FINALIZADO"]
  };
  return mapa[estadoActual] || ["EN_PROCESO", "CLASIFICADO", "ENVIADO", "CON_REPARTIDOR", "ENTREGADO", "FINALIZADO", "CANCELADO"];
}

function mostrarErrorLogin(mensaje = "") {
  const elemento = $("#loginError");
  elemento.textContent = mensaje;
  elemento.classList.toggle("hidden", !mensaje);
}

function aplicarPermisos() {
  const esAdmin = perfilActual?.rol === "admin";

  document.querySelectorAll("[data-admin-only]").forEach(elemento => {
    elemento.classList.toggle("hidden", !esAdmin);
  });

  $("#usuarioNombre").textContent =
    perfilActual?.nombre || usuarioActual?.email || "Usuario";

  $("#usuarioRol").textContent =
    esAdmin ? "Administrador" : "Vendedor";
}

async function cargarPerfilUsuario(user) {
  const referencia = doc(db, "usuarios", user.uid);
  const snapshot = await getDoc(referencia);

  if (!snapshot.exists()) {
    throw new Error(
      "Tu cuenta existe, pero todavía no tiene un perfil autorizado en Firestore."
    );
  }

  const perfil = snapshot.data();
  if (!["admin", "vendedor"].includes(perfil.rol)) {
    throw new Error("El rol asignado a esta cuenta no es válido.");
  }

  if (perfil.activo === false) {
    throw new Error("Esta cuenta se encuentra desactivada.");
  }

  return perfil;
}

function iniciarEscuchaPedidos() {
  if (cancelarEscuchaSurtidos) cancelarEscuchaSurtidos();

  const q = query(collection(db, "surtidos"), orderBy("creadoEn", "desc"));
  cancelarEscuchaSurtidos = onSnapshot(q, snapshot => {
    surtidos = snapshot.docs.map(d => ({ idFirestore: d.id, ...d.data() }));
    renderLista();

    if (perfilActual?.rol === "admin") {
      cancelarApartadosVencidos();
    }
  }, error => {
    $("#estadoConexion").textContent =
      "Error al leer Firestore. Revisa la configuración, el usuario y las reglas.";
    console.error(error);
  });
}

async function iniciarSesion(event) {
  event.preventDefault();
  mostrarErrorLogin("");

  const correo = $("#loginCorreo").value.trim();
  const contrasena = $("#loginContrasena").value;
  const boton = $("#btnIniciarSesion");

  boton.disabled = true;
  boton.textContent = "Ingresando…";

  try {
    await signInWithEmailAndPassword(auth, correo, contrasena);
  } catch (error) {
    console.error(error);
    const mensajes = {
      "auth/invalid-credential": "Correo o contraseña incorrectos.",
      "auth/invalid-email": "El correo electrónico no es válido.",
      "auth/too-many-requests": "Demasiados intentos. Espera unos minutos.",
      "auth/network-request-failed": "No se pudo conectar. Revisa tu internet."
    };
    mostrarErrorLogin(mensajes[error.code] || "No se pudo iniciar sesión.");
  } finally {
    boton.disabled = false;
    boton.textContent = "Iniciar sesión";
  }
}

async function cerrarSesion() {
  if (!confirm("¿Deseas cerrar la sesión?")) return;
  await signOut(auth);
}

onAuthStateChanged(auth, async user => {
  usuarioActual = user;

  if (!user) {
    perfilActual = null;
    surtidos = [];
    if (cancelarEscuchaSurtidos) {
      cancelarEscuchaSurtidos();
      cancelarEscuchaSurtidos = null;
    }

    $("#aplicacion").classList.add("hidden");
    $("#pantallaLogin").classList.remove("hidden");
    $("#formLogin").reset();
    mostrarErrorLogin("");
    return;
  }

  try {
    perfilActual = await cargarPerfilUsuario(user);
    aplicarPermisos();

    $("#pantallaLogin").classList.add("hidden");
    $("#aplicacion").classList.remove("hidden");
    $("#estadoConexion").textContent =
      `Conectado como ${perfilActual.nombre || user.email}. Los cambios se guardan automáticamente.`;

    iniciarEscuchaPedidos();
  } catch (error) {
    console.error(error);
    await signOut(auth);
    mostrarErrorLogin(error.message || "La cuenta no está autorizada.");
  }
});
function renderLista() {
  const texto = $("#buscador").value.trim().toLowerCase();
  const filtro = $("#filtroEstado").value;
  const filtroPago = $("#filtroPago").value;
  const filtroMetodo = $("#filtroMetodo").value;
  const filtroDevolucion = $("#filtroDevolucion").value;

  const filtrados = surtidos.filter(s => {
    const contenido = [
      s.folio, s.nombreCliente, s.ubicacion, s.responsable, s.vendedor,
      ...(s.productos || []).flatMap(p => [p.clave, p.nombre])
    ].filter(Boolean).join(" ").toLowerCase();
    const coincidePago = !filtroPago ||
      (filtroPago === "VENCIDO" ? apartadoVencido(s) : s.estatusPago === filtroPago);
    const coincideMetodo = !filtroMetodo ||
      pagosPedido(s).some(pago => pago.metodo === filtroMetodo);
    const tieneDevoluciones = (s.devoluciones || []).length > 0;
    const coincideDevolucion = !filtroDevolucion ||
      (filtroDevolucion === "CON_DEVOLUCION" && tieneDevoluciones) ||
      (filtroDevolucion === "SIN_DEVOLUCION" && !tieneDevoluciones);

    return (!texto || contenido.includes(texto)) &&
      (!filtro || s.estado === filtro) &&
      coincidePago &&
      coincideMetodo &&
      coincideDevolucion;
  });

  lista.innerHTML = "";
  $("#sinResultados").classList.toggle("hidden", filtrados.length > 0);

  for (const s of filtrados) {
    const nodo = $("#templateCard").content.cloneNode(true);
    nodo.querySelector(".card-id").textContent = s.folio || "Sin folio";
    const status = nodo.querySelector(".status");
    status.textContent =
      s.estado === "FINALIZADO" && s.cancelado
        ? "Finalizado · Cancelado"
        : textoEstado(s.estado);
    status.classList.add(s.estado || "EN_PROCESO");
    nodo.querySelector(".card-client").textContent = s.nombreCliente || "Cliente no registrado";
    nodo.querySelector(".card-date").textContent = `Fecha: ${fechaPedidoTexto(s)}`;
    const tipoOperacionTexto =
      s.tipoOperacion === "ALM"
        ? "Almacén"
        : s.tipoOperacion === "BAZ"
          ? "Bazar"
          : s.tipoOperacion === "VR"
            ? "Venta rápida"
            : "Pedido";

    nodo.querySelector(".card-location").textContent =
      `${tipoOperacionTexto} · Ubicación: ${s.ubicacion || "Sin ubicación"}`;
    const vencimiento = textoVencimiento(s);
    nodo.querySelector(".card-payment").innerHTML =
      `Pago: <strong>${escapeHtml(textoPago(s.estatusPago))}</strong> · Total ajustado: ${moneda(totalAjustadoPedido(s))} · Pagado: ${moneda(totalPagado(s))} · Saldo: ${moneda(saldoPendiente(s))}
      ${vencimiento ? `<br><span class="${apartadoVencido(s) ? "overdue-text" : "deadline-text"}">${escapeHtml(vencimiento)}</span>` : ""}`;
    nodo.querySelector(".card-count").textContent =
      `${s.productos?.length || 0} productos · ${totalPiezas(s.productos)} piezas${(s.devoluciones || []).length ? " · Con devolución" : ""}`;

    const tarjeta = nodo.querySelector(".card");
    if (s.estado === "FINALIZADO" && (s.devoluciones || []).length) {
      tarjeta.classList.add("finalized-return-card");
    }

    const botonPagoRapido = nodo.querySelector(".card-quick-pay");
    const puedeAgregarPago =
      saldoPendiente(s) > 0.009 && !["CANCELADO", "FINALIZADO"].includes(s.estado);
    botonPagoRapido.classList.toggle("hidden", !puedeAgregarPago);
    botonPagoRapido.addEventListener("click", event => {
      event.stopPropagation();
      surtidoActual = s;
      abrirPago();
    });

    nodo.querySelector(".card-open").addEventListener("click", () => abrirDetalle(s));
    lista.appendChild(nodo);
  }

  $("#totalHoy").textContent = surtidos.filter(hoyMismo).length;
  $("#totalProceso").textContent = surtidos.filter(s => s.estado === "EN_PROCESO").length;
  $("#totalRuta").textContent = surtidos.filter(s => ["CLASIFICADO", "ENVIADO", "CON_REPARTIDOR"].includes(s.estado)).length;
  $("#totalFinalizados").textContent = surtidos.filter(s => ["ENTREGADO", "FINALIZADO"].includes(s.estado)).length;
}

function costoEnvioNuevo() {
  const tipoEntrega =
    document.querySelector('input[name="tipoEntrega"]:checked')?.value || "";

  if (tipoEntrega !== "DOMICILIO") return 0;

  const costo = Number($("#costoEnvio").value || 0);
  return Number.isFinite(costo) && costo > 0 ? costo : 0;
}

function totalNuevoPedido() {
  return totalPedido(productosNuevo) + costoEnvioNuevo();
}

function actualizarTotalNuevo() {
  $("#totalNuevo").textContent = moneda(totalNuevoPedido());
}

function renderProductosNuevo() {
  const cont = $("#productosNuevo");
  cont.innerHTML = "";
  productosNuevo.forEach((p, index) => {
    const row = document.createElement("div");
    row.className = "product-row";
    row.innerHTML = `
      <div><strong>${escapeHtml(p.nombre)}</strong><br><small>${escapeHtml(p.clave || "Sin clave")}</small></div>
      <span>${moneda(p.costo)} c/u</span>
      <span>${p.cantidad} pza.</span>
      <button type="button" class="danger">Quitar</button>`;
    row.querySelector("button").addEventListener("click", () => {
      productosNuevo.splice(index, 1);
      renderProductosNuevo();
      actualizarTotalNuevo();
    });
    cont.appendChild(row);
  });
}

function agregarProducto() {
  const clave = limpiarClaveProducto($("#productoClave").value);
  $("#productoClave").value = clave;

  if (clave && !$("#productoNombre").value.trim()) {
    buscarProductoCatalogo();
  }

  const nombre = $("#productoNombre").value.trim();
  const costo = Number($("#productoCosto").value);
  const cantidad = Number($("#productoCantidad").value);

  if (!nombre) return alert("Escribe el nombre del producto.");
  if (!Number.isFinite(costo) || costo <= 0) return alert("El costo debe ser mayor a cero.");
  if (!Number.isInteger(cantidad) || cantidad < 1) return alert("La cantidad debe ser un número entero mayor a cero.");

  const claveNormalizada = limpiarClaveProducto(clave);
  const nombreNormalizado = nombre.trim().toLowerCase();

  const productoExistente = productosNuevo.find(producto => {
    const mismaClave =
      claveNormalizada &&
      limpiarClaveProducto(producto.clave) === claveNormalizada;

    const mismoProductoSinClave =
      !claveNormalizada &&
      !limpiarClaveProducto(producto.clave) &&
      String(producto.nombre || "").trim().toLowerCase() === nombreNormalizado &&
      Number(producto.costo || 0) === costo;

    return mismaClave || mismoProductoSinClave;
  });

  if (productoExistente) {
    productoExistente.cantidad =
      Number(productoExistente.cantidad || 0) + cantidad;

    // The first registered name and price are preserved.
    // Only the quantity is accumulated when the same product is scanned again.
  } else {
    productosNuevo.push({
      idLinea: crypto.randomUUID(),
      clave,
      nombre,
      costo,
      cantidad
    });
  }

  $("#productoClave").value = "";
  $("#productoNombre").value = "";
  $("#productoCosto").value = "";
  $("#productoCantidad").value = "1";
  $("#productoClave")?.focus();
  renderProductosNuevo();
  actualizarTotalNuevo();
}

function validarPedido() {
  const tipoOperacion = $("#tipoOperacion").value;
  const esVentaRapida = tipoOperacion === "VR";
  const tipoEntrega = document.querySelector('input[name="tipoEntrega"]:checked')?.value;

  if (!esVentaRapida) {
    if (!tipoEntrega) {
      alert("Selecciona si la entrega es en punto de entrega o domicilio.");
      return false;
    }
    if (tipoEntrega === "PUNTO_ENTREGA" && !$("#puntoEntrega").value) {
      alert("Selecciona el punto de entrega.");
      $("#puntoEntrega")?.focus();
      return false;
    }
    if (tipoEntrega === "DOMICILIO" && !$("#ubicacion").value.trim()) {
      alert("Escribe el domicilio de entrega.");
      $("#ubicacion")?.focus();
      return false;
    }

    if (tipoEntrega === "DOMICILIO") {
      const costoEnvio = Number($("#costoEnvio").value);
      if (!Number.isFinite(costoEnvio) || costoEnvio < 0) {
        alert("Escribe un costo de envío válido.");
        $("#costoEnvio")?.focus();
        return false;
      }
    }
  }

  const campos = [
    ["tipoOperacion", "Selecciona el tipo de operación."],
    ["nombreCliente", "Escribe el nombre del cliente."],
    ["responsable", "Selecciona al responsable."],
    ["vendedor", "Escribe el nombre del vendedor."],
    ["estatusPago", "Selecciona el estatus de pago."]
  ];
  for (const [id, mensaje] of campos) {
    if (!$("#" + id).value.trim()) {
      alert(mensaje);
      $("#" + id)?.focus();
      return false;
    }
  }
  if ($("#estatusPago").value !== "PENDIENTE" && !$("#metodoPagoInicial").value.trim()) {
    alert("Selecciona el método del primer pago.");
    $("#metodoPagoInicial")?.focus();
    return false;
  }
  if (!productosNuevo.length) {
    alert("Agrega por lo menos un producto.");
    return false;
  }
  const total = totalNuevoPedido();
  if ($("#estatusPago").value === "APARTADO") {
    const apartado = Number($("#montoApartado").value);
    if (!Number.isFinite(apartado) || apartado <= 0) {
      alert("Escribe una cantidad válida para el apartado.");
      return false;
    }
    if (apartado > total) {
      alert("El apartado no puede ser mayor al total del pedido.");
      return false;
    }
  }
  return true;
}

async function guardarPedido(imprimir) {
  if (!validarPedido()) return;

  const tipoOperacion = $("#tipoOperacion").value;
  const estatusPago = $("#estatusPago").value;
  const estado = tipoOperacion === "VR" ? "FINALIZADO" : $("#estadoInicial").value;
  const costoEnvio = tipoOperacion === "VR" ? 0 : costoEnvioNuevo();
  const totalProductos = totalPedido(productosNuevo);
  const total = totalProductos + costoEnvio;
  const tienePagoInicial = estatusPago !== "PENDIENTE";
  const montoInicial = estatusPago === "APARTADO"
    ? Number($("#montoApartado").value)
    : estatusPago === "PAGADO" ? total : 0;
  const pagoInicial = tienePagoInicial ? {
    id: crypto.randomUUID(),
    monto: montoInicial,
    metodo: $("#metodoPagoInicial").value,
    fecha: $("#fechaPagoInicial").value,
    fechaISO: new Date().toISOString()
  } : null;

  const registro = {
    folio: siguienteFolio(tipoOperacion),
    fechaPedido: $("#fechaPedido").value,
    tipoOperacion,
    nombreCliente: $("#nombreCliente").value.trim(),
    tipoEntrega: tipoOperacion === "VR"
      ? "VENTA_RAPIDA"
      : document.querySelector('input[name="tipoEntrega"]:checked').value,
    puntoEntrega: tipoOperacion === "VR" ? "" : $("#puntoEntrega").value,
    ubicacion: tipoOperacion === "VR"
      ? "Venta rápida"
      : document.querySelector('input[name="tipoEntrega"]:checked').value === "PUNTO_ENTREGA"
        ? $("#puntoEntrega").value
        : $("#ubicacion").value.trim(),
    responsable: $("#responsable").value,
    vendedor: $("#vendedor").value.trim(),
    estatusPago,
    montoApartado: montoInicial,
    metodoPago: pagoInicial?.metodo || "",
    fechaPago: pagoInicial?.fecha || "",
    pagos: pagoInicial ? [pagoInicial] : [],
    productos: productosNuevo,
    subtotalProductos: totalProductos,
    costoEnvio,
    total,
    estado,
    creadoPorUid: usuarioActual?.uid || "",
    creadoPorNombre: perfilActual?.nombre || usuarioActual?.email || "",
    creadoPorRol: perfilActual?.rol || "",
    creadoEn: serverTimestamp(),
    actualizadoEn: serverTimestamp(),
    devoluciones: [],
    historial: [{
      tipo: "PEDIDO_CREADO",
      detalle: `Pedido creado con estatus ${textoEstado(estado)}`,
      fechaISO: new Date().toISOString()
    }]
  };

  try {
    await addDoc(collection(db, "surtidos"), registro);
    modalSurtido.close();
    $("#formSurtido").reset();
    productosNuevo = [];
    renderProductosNuevo();
    actualizarTotalNuevo();
    if (imprimir) imprimirEtiqueta({ ...registro, creadoEn: new Date() });
  } catch (error) {
    alert("No se pudo guardar el pedido.");
    console.error(error);
  }
}

function abrirDetalle(s) {
  surtidoActual = s;
  $("#detalleId").textContent = s.folio || "Pedido";
  $("#detalleFecha").textContent = fechaPedidoTexto(s);

  const productosHtml = (s.productos || []).map(p => `
    <div class="product-row">
      <div><strong>${escapeHtml(p.nombre)}</strong><br><small>${escapeHtml(p.clave || "Sin clave")}</small></div>
      <span>${moneda(p.costo || 0)} c/u</span>
      <span>${p.cantidad} pza.</span>
      <strong>${moneda(Number(p.cantidad || 0) * Number(p.costo || 0))}</strong>
    </div>`).join("");

  const devolucionesHtml = (s.devoluciones || []).map(d => `
    <div class="history-item">
      <strong>Devolución: ${escapeHtml(d.motivo)} · -${moneda(d.importeAjuste || 0)}</strong><br>
      <small>${escapeHtml(d.fechaLocal)} · Revisión: ${escapeHtml(textoEstatusRevision(d.estatusRevision))} · ${escapeHtml(d.observaciones || "Sin observaciones")}</small>
    </div>`).join("");

  $("#detalleContenido").innerHTML = `
    <div class="detail-meta">
      <div><small>Cliente</small><strong>${escapeHtml(s.nombreCliente || "No registrado")}</strong></div>
      <div><small>Tipo de entrega</small><strong>${
        s.tipoEntrega === "PUNTO_ENTREGA"
          ? "Punto de entrega"
          : s.tipoEntrega === "DOMICILIO"
            ? "Domicilio"
            : s.tipoEntrega === "VENTA_RAPIDA"
              ? "Venta rápida"
              : "No registrado"
      }</strong></div>
      <div><small>Ubicación</small><strong>${escapeHtml(s.ubicacion || "No registrada")}</strong></div>
      <div><small>Tipo de operación</small><strong>${
        s.tipoOperacion === "ALM"
          ? "Almacén"
          : s.tipoOperacion === "BAZ"
            ? "Bazar"
            : s.tipoOperacion === "VR"
              ? "Venta rápida"
              : "Anterior"
      }</strong></div>
      <div><small>Estado</small><strong>${
        s.estado === "FINALIZADO" && s.cancelado
          ? "Finalizado · Cancelado"
          : textoEstado(s.estado)
      }</strong></div>
      <div><small>Pago</small><strong>${textoPago(s.estatusPago)}</strong></div>
      <div><small>Subtotal de productos</small><strong>${moneda(Number(s.subtotalProductos ?? totalPedido(s.productos)))}</strong></div>
      <div><small>Costo de envío</small><strong>${moneda(Number(s.costoEnvio || 0))}</strong></div>
      <div><small>Total original</small><strong>${moneda(s.total || totalPedido(s.productos))}</strong></div>
      <div><small>Ajustes por devolución</small><strong class="return-amount">-${moneda(importeDevoluciones(s))}</strong></div>
      <div><small>Total ajustado</small><strong>${moneda(totalAjustadoPedido(s))}</strong></div>
      <div><small>Total pagado</small><strong>${moneda(totalPagado(s))}</strong></div>
      <div><small>Saldo pendiente</small><strong>${moneda(saldoPendiente(s))}</strong></div>
      <div><small>Saldo a favor</small><strong>${moneda(saldoFavor(s))}</strong></div>
      ${s.motivoCancelacion === "APARTADO_VENCIDO" ? `
        <div class="span-detail cancellation-credit">
          <small>Cancelación por falta de liquidación</small>
          <strong>Saldo positivo a favor del cliente: ${moneda(Number(s.saldoFavorCancelacion ?? totalPagado(s)))}</strong>
          <p>Regresa todos los productos de este pedido al inventario y confirma la acción para finalizar.</p>
        </div>` : ""}
      <div><small>Vigencia del apartado</small><strong class="${apartadoVencido(s) ? "overdue-text" : ""}">${escapeHtml(textoVencimiento(s) || "No aplica")}</strong></div>
      <div><small>Responsable</small><strong>${escapeHtml(s.responsable || "No registrado")}</strong></div>
      <div><small>Vendedor</small><strong>${escapeHtml(s.vendedor || "No registrado")}</strong></div>
      <div><small>Piezas</small><strong>${totalPiezas(s.productos)}</strong></div>
    </div>
    <h3>Historial de pagos</h3>
    <div class="payment-history">
      ${pagosPedido(s).length ? pagosPedido(s).map((pago, indice) => `
        <div class="payment-item">
          <div><strong>Pago ${indice + 1}</strong><small>${escapeHtml(pago.fecha || "Sin fecha")}</small></div>
          <div>${escapeHtml(metodoPagoTexto(pago.metodo))}</div>
          <strong>${moneda(pago.monto)}</strong>
        </div>`).join("") : "<p>No hay pagos registrados.</p>"}
    </div>
    <h3>Productos</h3>
    <div class="product-list">${productosHtml}</div>
    ${(s.devoluciones || []).length ? `<div class="history"><h3 class="return-flag">Devoluciones</h3>${devolucionesHtml}</div>` : ""}
  `;

  const panelActualizarEstado = $("#panelActualizarEstado");
  panelActualizarEstado.classList.toggle("hidden", s.estado === "FINALIZADO");

  const selector = $("#cambiarEstado");
  selector.innerHTML = "";
  const permitidos = transicionesPermitidas(s.estado);
  if (!permitidos.length) {
    selector.innerHTML = `<option value="">Sin cambios disponibles</option>`;
    $("#btnCambiarEstado").disabled = true;
  } else {
    for (const estado of permitidos) {
      selector.insertAdjacentHTML("beforeend", `<option value="${estado}">${textoEstado(estado)}</option>`);
    }
    $("#btnCambiarEstado").disabled = false;
  }

  const devolucionPermitidaFinalizado =
    s.estado === "FINALIZADO" &&
    !s.cancelado &&
    ["ALM", "BAZ", "VR"].includes(s.tipoOperacion);

  const ocultarRegistroDevolucion =
    ["EN_PROCESO", "CANCELADO"].includes(s.estado) ||
    (s.estado === "FINALIZADO" && !devolucionPermitidaFinalizado) ||
    !tieneProductosDisponiblesParaDevolver(s);

  $("#btnAbrirDevolucion").classList.toggle("hidden", ocultarRegistroDevolucion);
  $("#btnAgregarPago").classList.toggle("hidden",
    s.estatusPago === "PAGADO" || saldoPendiente(s) <= 0 || ["CANCELADO", "FINALIZADO"].includes(s.estado)
  );

  const cancelacionVencidaPendiente =
    s.motivoCancelacion === "APARTADO_VENCIDO" &&
    s.devolucionInventarioPendiente !== false &&
    !s.productosRegresadosInventario;

  const requiereRevisionInventario =
    tieneDevolucionesPendientesRevision(s) || cancelacionVencidaPendiente;

  const cajaInventario = $("#confirmacionInventarioBox");
  const checkInventario = $("#confirmarSumaInventario");

  if (cancelacionVencidaPendiente) {
    $("#tituloConfirmacionInventario").textContent = "Productos regresados al inventario";
    $("#textoConfirmacionInventario").textContent =
      "Confirma que todos los productos del pedido cancelado ya fueron regresados al inventario.";
  } else {
    $("#tituloConfirmacionInventario").textContent = "Devolución registrada en el sistema";
    $("#textoConfirmacionInventario").textContent =
      "Confirma que la devolución ya fue registrada en el sistema antes de finalizar el pedido.";
  }

  cajaInventario.classList.toggle("hidden", !requiereRevisionInventario);
  checkInventario.checked = false;

  if (!modalDetalle.open) modalDetalle.showModal();
}


function actualizarConfirmacionInventarioPorEstado() {
  if (!surtidoActual) return;
  const caja = $("#confirmacionInventarioBox");
  const nuevoEstado = $("#cambiarEstado").value;
  const requiere =
    tieneDevolucionesPendientesRevision(surtidoActual) ||
    (
      surtidoActual.motivoCancelacion === "APARTADO_VENCIDO" &&
      surtidoActual.devolucionInventarioPendiente !== false &&
      !surtidoActual.productosRegresadosInventario
    );

  caja.classList.toggle("hidden", !requiere);
  caja.classList.toggle("required-now", requiere && nuevoEstado === "FINALIZADO");
}

async function cambiarEstado() {
  if (!surtidoActual) return;
  const nuevoEstado = $("#cambiarEstado").value;
  if (!nuevoEstado) return;

  const cancelacionPorVencimiento =
    surtidoActual.motivoCancelacion === "APARTADO_VENCIDO";

  if (
    nuevoEstado === "FINALIZADO" &&
    saldoPendiente(surtidoActual) > 0.009 &&
    !cancelacionPorVencimiento
  ) {
    alert(
      `No puedes finalizar la venta porque todavía existe un saldo pendiente de ${moneda(saldoPendiente(surtidoActual))}. ` +
      "Registra los pagos necesarios hasta liquidar el total ajustado del pedido."
    );
    return;
  }

  const requiereConfirmacionInventario =
    nuevoEstado === "FINALIZADO" && (
      tieneDevolucionesPendientesRevision(surtidoActual) ||
      (
        surtidoActual.motivoCancelacion === "APARTADO_VENCIDO" &&
        surtidoActual.devolucionInventarioPendiente !== false &&
        !surtidoActual.productosRegresadosInventario
      )
    );

  if (requiereConfirmacionInventario && !$("#confirmarSumaInventario").checked) {
    alert(
      surtidoActual.motivoCancelacion === "APARTADO_VENCIDO"
        ? "Antes de finalizar debes confirmar que los productos ya fueron regresados al inventario."
        : "Antes de finalizar debes confirmar que la devolución ya fue registrada en el sistema."
    );
    $("#confirmarSumaInventario")?.focus();
    return;
  }

  const devolucionesActualizadas = requiereConfirmacionInventario
    ? (surtidoActual.devoluciones || []).map(devolucion => ({
        ...devolucion,
        estatusRevision: "REGISTRADA_SISTEMA",
        registradoSistema: true,
        registradoSistemaFecha: fechaSoloDia(),
        registradoSistemaFechaISO: new Date().toISOString()
      }))
    : (surtidoActual.devoluciones || []);

  const esCancelacion = nuevoEstado === "CANCELADO";
  const dineroAportadoCancelacion =
    esCancelacion ? totalPagado(surtidoActual) : 0;
  const estadoGuardado = esCancelacion ? "FINALIZADO" : nuevoEstado;

  const mensaje = nuevoEstado === "CANCELADO"
    ? dineroAportadoCancelacion > 0
      ? `¿Seguro que deseas cancelar este pedido? Se registrará una salida de caja por ${moneda(dineroAportadoCancelacion)}.`
      : "¿Seguro que deseas cancelar este pedido?"
    : `¿Cambiar el pedido a "${textoEstado(nuevoEstado)}"?`;

  if (!confirm(mensaje)) return;

  establecerCargaModal(modalDetalle, true, "Actualizando estatus…");

  try {
    await updateDoc(doc(db, "surtidos", surtidoActual.idFirestore), {
      estado: estadoGuardado,
      cancelado: esCancelacion ? true : surtidoActual.cancelado || false,
      motivoCancelacion:
        esCancelacion
          ? (surtidoActual.motivoCancelacion || "CANCELACION_MANUAL")
          : surtidoActual.motivoCancelacion || "",
      fechaCancelacion:
        esCancelacion
          ? fechaSoloDia()
          : surtidoActual.fechaCancelacion || "",
      reversoCajaCancelacion:
        esCancelacion
          ? dineroAportadoCancelacion > 0
          : surtidoActual.reversoCajaCancelacion || false,
      saldoFavorCancelacion:
        esCancelacion
          ? dineroAportadoCancelacion
          : Number(surtidoActual.saldoFavorCancelacion || 0),
      productosRegresadosInventario:
        nuevoEstado === "FINALIZADO" && cancelacionPorVencimiento
          ? true
          : surtidoActual.productosRegresadosInventario || false,
      devolucionInventarioPendiente:
        nuevoEstado === "FINALIZADO" && cancelacionPorVencimiento
          ? false
          : surtidoActual.devolucionInventarioPendiente ?? false,
      actualizadoEn: serverTimestamp(),
      finalizadoEn:
        estadoGuardado === "FINALIZADO"
          ? serverTimestamp()
          : surtidoActual.finalizadoEn || null,
      historial: arrayUnion({
        tipo: "CAMBIO_ESTADO",
        detalle: esCancelacion
          ? dineroAportadoCancelacion > 0
            ? `Pedido cancelado y finalizado. Salida de caja: ${moneda(dineroAportadoCancelacion)}.`
            : "Pedido cancelado y finalizado. Sin dinero recibido."
          : `Estado cambiado de ${textoEstado(surtidoActual.estado)} a ${textoEstado(nuevoEstado)}`,
        fechaISO: new Date().toISOString()
      })
    });

    surtidoActual = {
      ...surtidoActual,
      estado: estadoGuardado,
      devoluciones: devolucionesActualizadas,
      cancelado: esCancelacion ? true : surtidoActual.cancelado || false,
      motivoCancelacion:
        esCancelacion
          ? (surtidoActual.motivoCancelacion || "CANCELACION_MANUAL")
          : surtidoActual.motivoCancelacion || "",
      fechaCancelacion:
        esCancelacion
          ? fechaSoloDia()
          : surtidoActual.fechaCancelacion || "",
      reversoCajaCancelacion:
        esCancelacion
          ? dineroAportadoCancelacion > 0
          : surtidoActual.reversoCajaCancelacion || false,
      saldoFavorCancelacion:
        esCancelacion
          ? dineroAportadoCancelacion
          : Number(surtidoActual.saldoFavorCancelacion || 0),
      productosRegresadosInventario:
        nuevoEstado === "FINALIZADO" && cancelacionPorVencimiento
          ? true
          : surtidoActual.productosRegresadosInventario || false,
      devolucionInventarioPendiente:
        nuevoEstado === "FINALIZADO" && cancelacionPorVencimiento
          ? false
          : surtidoActual.devolucionInventarioPendiente ?? false,
      finalizadoEn:
        estadoGuardado === "FINALIZADO"
          ? new Date()
          : surtidoActual.finalizadoEn
    };
    if (esCancelacion) {
      modalDetalle.close();
      renderLista();
    } else {
      abrirDetalle(surtidoActual);
      mostrarResultadoModal(modalDetalle, `Estatus actualizado: ${textoEstado(nuevoEstado)}.`);
    }
  } catch (error) {
    alert("No se pudo actualizar el estado.");
    console.error(error);
  } finally {
    establecerCargaModal(modalDetalle, false);
  }
}


function abrirPago() {
  if (!surtidoActual) return;
  const saldo = saldoPendiente(surtidoActual);
  if (saldo <= 0) {
    alert("Este pedido ya está pagado.");
    return;
  }
  $("#formPago").reset();
  $("#pagoFolio").textContent = surtidoActual.folio || "";
  $("#nuevaFechaPago").value = fechaSoloDia();
  actualizarResumenModalPago(surtidoActual);
  modalDetalle.close();
  modalPago.showModal();
}

function actualizarResumenModalPago(pedido) {
  const saldo = saldoPendiente(pedido);
  $("#nuevoMontoPago").max = String(saldo);
  $("#resumenPago").innerHTML = `
    <div><small>Total ajustado</small><strong>${moneda(totalAjustadoPedido(pedido))}</strong></div>
    <div><small>Total pagado</small><strong>${moneda(totalPagado(pedido))}</strong></div>
    <div><small>Saldo pendiente</small><strong>${moneda(saldo)}</strong></div>
  `;
}

async function guardarNuevoPago(event) {
  event.preventDefault();
  if (!surtidoActual) return;

  const monto = Number($("#nuevoMontoPago").value);
  const metodo = $("#nuevoMetodoPago").value;
  const saldo = saldoPendiente(surtidoActual);

  if (!Number.isFinite(monto) || monto <= 0) {
    alert("Escribe una cantidad válida.");
    return;
  }
  if (monto > saldo) {
    alert(`El pago no puede superar el saldo pendiente de ${moneda(saldo)}.`);
    return;
  }
  if (!metodo) {
    alert("Selecciona el método de pago.");
    return;
  }

  const pago = {
    id: crypto.randomUUID(),
    monto,
    metodo,
    fecha: fechaSoloDia(),
    fechaISO: new Date().toISOString()
  };
  const nuevoTotalPagado = totalPagado(surtidoActual) + monto;
  const total = totalAjustadoPedido(surtidoActual);
  const nuevoEstatusPago = nuevoTotalPagado >= total ? "PAGADO" : "APARTADO";

  establecerCargaModal(modalPago, true, "Registrando pago…");

  try {
    await updateDoc(doc(db, "surtidos", surtidoActual.idFirestore), {
      pagos: arrayUnion(pago),
      estatusPago: nuevoEstatusPago,
      montoApartado: nuevoTotalPagado,
      metodoPago: metodo,
      fechaPago: pago.fecha,
      actualizadoEn: serverTimestamp(),
      historial: arrayUnion({
        tipo: "PAGO_AGREGADO",
        detalle: `${moneda(monto)} por ${metodoPagoTexto(metodo)}. Estatus: ${textoPago(nuevoEstatusPago)}`,
        fechaISO: new Date().toISOString()
      })
    });

    surtidoActual = {
      ...surtidoActual,
      pagos: [...pagosPedido(surtidoActual), pago],
      estatusPago: nuevoEstatusPago,
      montoApartado: nuevoTotalPagado,
      metodoPago: metodo,
      fechaPago: pago.fecha
    };

    $("#formPago").reset();
    modalPago.close();
    renderLista();
  } catch (error) {
    alert("No se pudo guardar el pago.");
    console.error(error);
  } finally {
    establecerCargaModal(modalPago, false);
  }
}

function abrirDevolucion() {
  if (!surtidoActual) return;
  $("#devolucionId").textContent = surtidoActual.folio;
  const cont = $("#productosDevolucion");
  cont.innerHTML = "";

  for (const p of surtidoActual.productos || []) {
    const yaDevuelto = (surtidoActual.devoluciones || []).reduce((sum, devolucion) => {
      const encontrado = (devolucion.productos || []).find(item => item.idLinea === p.idLinea);
      return sum + Number(encontrado?.cantidadDevuelta || 0);
    }, 0);
    const disponible = Math.max(0, Number(p.cantidad || 0) - yaDevuelto);
    if (disponible <= 0) continue;
    const row = document.createElement("label");
    row.className = "return-row";
    row.innerHTML = `
      <input type="checkbox" data-id="${p.idLinea}">
      <span><strong>${escapeHtml(p.nombre)}</strong><br><small>${escapeHtml(p.clave || "Sin clave")}</small></span>
      <input type="number" min="1" max="${disponible}" value="1" disabled>
      <small class="return-available">Disponible para devolución: ${disponible}</small>`;
    const check = row.querySelector('input[type="checkbox"]');
    const qty = row.querySelector('input[type="number"]');
    check.addEventListener("change", () => qty.disabled = !check.checked);
    cont.appendChild(row);
  }

  modalDevolucion.showModal();
}

async function guardarDevolucion(event) {
  event.preventDefault();
  if (!surtidoActual) return;

  const seleccionados = [...$("#productosDevolucion").querySelectorAll(".return-row")]
    .filter(row => row.querySelector('input[type="checkbox"]').checked)
    .map(row => {
      const id = row.querySelector('input[type="checkbox"]').dataset.id;
      const original = surtidoActual.productos.find(p => p.idLinea === id);
      return { ...original, cantidadDevuelta: Number(row.querySelector('input[type="number"]').value) };
    });

  if (!seleccionados.length) return alert("Selecciona por lo menos un producto.");

  const motivo = $("#motivoDevolucion").value;
  if (!motivo) return alert("Selecciona el motivo de devolución.");

  const importeAjuste = seleccionados.reduce((sum, producto) =>
    sum + Number(producto.cantidadDevuelta || 0) * Number(producto.costo || 0), 0);

  const devolucion = {
    id: crypto.randomUUID(),
    productos: seleccionados,
    motivo,
    observaciones: $("#observacionesDevolucion").value.trim(),
    importeAjuste,
    estatusRevision: "PENDIENTE_SISTEMA",
    registradoSistema: false,
    sumadoInventario: false,
    reincorporadoSicar: false,
    estatusSicar: "PENDIENTE",
    fecha: fechaSoloDia(),
    fechaISO: new Date().toISOString(),
    fechaLocal: new Date().toLocaleString("es-MX")
  };

  const pedidoSimulado = {
    ...surtidoActual,
    devoluciones: [...(surtidoActual.devoluciones || []), devolucion]
  };
  const nuevoEstatusPago = estatusPagoCalculado(pedidoSimulado);

  establecerCargaModal(modalDevolucion, true, "Guardando devolución…");

  try {
    await updateDoc(doc(db, "surtidos", surtidoActual.idFirestore), {
      devoluciones: arrayUnion(devolucion),
      estado: "CON_DEVOLUCION",
      estatusPago: nuevoEstatusPago,
      actualizadoEn: serverTimestamp(),
      historial: arrayUnion({
        tipo: "DEVOLUCION",
        detalle: `${seleccionados.length} producto(s): ${motivo}. Ajuste: -${moneda(importeAjuste)}. Pendiente de registrar en el sistema.`,
        fechaISO: new Date().toISOString()
      })
    });

    surtidoActual = {
      ...surtidoActual,
      devoluciones: [...(surtidoActual.devoluciones || []), devolucion],
      estado: "CON_DEVOLUCION",
      estatusPago: nuevoEstatusPago
    };

    $("#formDevolucion").reset();
    modalDevolucion.close();
    abrirDetalle(surtidoActual);
    renderLista();
  } catch (error) {
    alert("No se pudo guardar la devolución.");
    console.error(error);
  } finally {
    establecerCargaModal(modalDevolucion, false);
  }
}

function imprimirEtiqueta(s) {
  if (!s) {
    alert("No se encontró la información del pedido para imprimir.");
    return;
  }

  const anterior = document.querySelector("#printArea");
  if (anterior) anterior.remove();

  const productos = Array.isArray(s.productos) ? s.productos : [];
  const tipoTexto =
    s.tipoOperacion === "ALM"
      ? "ALMACÉN"
      : s.tipoOperacion === "BAZ"
        ? "BAZAR"
        : s.tipoOperacion === "VR"
          ? "VENTA RÁPIDA"
          : "PEDIDO";
  const cliente = s.nombreCliente || "Cliente no registrado";
  const ubicacionTexto = s.ubicacion || "Sin ubicación";

  const printArea = document.createElement("section");
  printArea.id = "printArea";
  printArea.innerHTML = `
    <div class="print-header">
    <p><img src="/logo.JPG" alt="Noventia" style="width: 200px"/></p>
      <strong class="print-type">${escapeHtml(tipoTexto)}</strong>
      <h1>${escapeHtml(s.folio || "SIN FOLIO")}</h1>
    </div>
    <div class="print-data">
      <p><strong>Fecha:</strong> ${escapeHtml(fechaPedidoTexto(s))}</p>
      <p><strong>Cliente:</strong> ${escapeHtml(cliente)}</p>
      <p><strong>Vendedor:</strong> ${escapeHtml(s.vendedor || "No registrado")}</p>
      <p><strong>Pago:</strong> ${escapeHtml(textoPago(s.estatusPago))}</p>
      <p><strong>Subtotal de productos:</strong> ${escapeHtml(moneda(Number(s.subtotalProductos ?? totalPedido(s.productos))))}</p>
      <p><strong>Costo de envío:</strong> ${escapeHtml(moneda(Number(s.costoEnvio || 0)))}</p>
      <p><strong>Total original:</strong> ${escapeHtml(moneda(s.total || totalPedido(s.productos)))}</p>
      <p><strong>Devoluciones:</strong> -${escapeHtml(moneda(importeDevoluciones(s)))}</p>
      <p><strong>Total ajustado:</strong> ${escapeHtml(moneda(totalAjustadoPedido(s)))}</p>
      <p><strong>Pagado:</strong> ${escapeHtml(moneda(totalPagado(s)))}</p>
      <p><strong>Saldo:</strong> ${escapeHtml(moneda(saldoPendiente(s)))}</p>
      <p><strong>Método(s):</strong> ${escapeHtml([...new Set(pagosPedido(s).map(p => metodoPagoTexto(p.metodo)))].join(", ") || "No registrado")}</p>
      <p><strong>Ubicación:</strong> ${escapeHtml(ubicacionTexto)}</p>
    </div>
    <div class="print-products">
      <strong>Productos:</strong>
      ${productos.length
        ? productos.map(p => `<p>${Number(p.cantidad || 0)} × ${escapeHtml(p.nombre || "Producto sin nombre")}</p>`).join("")
        : "<p>Sin productos registrados</p>"}
    </div>
  `;

  document.body.appendChild(printArea);
  document.body.classList.add("printing-label");

  const limpiarImpresion = () => {
    document.body.classList.remove("printing-label");
    printArea.remove();
    window.removeEventListener("afterprint", limpiarImpresion);
  };

  window.addEventListener("afterprint", limpiarImpresion);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.print();
    });
  });
}

function exportarPedidos() {
  if (perfilActual?.rol !== "admin") return alert("Solo el administrador puede exportar pedidos.");
  if (!surtidos.length) return alert("No hay pedidos para exportar.");
  if (typeof XLSX === "undefined") return alert("No se pudo cargar el generador de Excel.");

  const filasPedidos = surtidos.map(s => ({
    Folio: s.folio || "",
    Fecha: fechaPedidoTexto(s),
    "Tipo de operación": s.tipoOperacion === "ALM"
      ? "Almacén"
      : s.tipoOperacion === "BAZ"
        ? "Bazar"
        : s.tipoOperacion === "VR"
          ? "Venta rápida"
          : "",
    Cliente: s.nombreCliente || "",
    "Tipo de entrega": s.tipoEntrega === "PUNTO_ENTREGA" ? "Punto de entrega" : s.tipoEntrega === "DOMICILIO" ? "Domicilio" : "",
    Ubicación: s.ubicacion || "",
    Responsable: s.responsable || "",
    Vendedor: s.vendedor || "",
    Estado: textoEstado(s.estado),
    "Estatus de pago": textoPago(s.estatusPago),
    "Subtotal de productos": Number(s.subtotalProductos ?? totalPedido(s.productos)),
    "Costo de envío": Number(s.costoEnvio || 0),
    "Total original": Number(s.total || totalPedido(s.productos)),
    "Ajustes por devolución": importeDevoluciones(s),
    "Total ajustado": totalAjustadoPedido(s),
    "Total pagado": totalPagado(s),
    "Saldo pendiente": saldoPendiente(s),
    "Saldo a favor": saldoFavor(s),
    "Saldo positivo por cancelación": Number(s.saldoFavorCancelacion || 0),
    "Productos regresados al inventario": s.productosRegresadosInventario ? "Sí" : "No",
    "Métodos de pago": [...new Set(pagosPedido(s).map(p => metodoPagoTexto(p.metodo)))].join(", "),
    "Vencimiento apartado": textoVencimiento(s),
    Total: Number(s.total || totalPedido(s.productos)),
    "Productos distintos": s.productos?.length || 0,
    "Piezas totales": totalPiezas(s.productos),
    "Número de devoluciones": s.devoluciones?.length || 0
  }));

  const filasProductos = [];
  for (const s of surtidos) {
    for (const p of s.productos || []) {
      filasProductos.push({
        Folio: s.folio || "",
        Fecha: fechaPedidoTexto(s),
        Cliente: s.nombreCliente || "",
        Clave: p.clave || "",
        Producto: p.nombre || "",
        "Costo unitario": Number(p.costo || 0),
        Cantidad: Number(p.cantidad || 0),
        Subtotal: Number(p.costo || 0) * Number(p.cantidad || 0)
      });
    }
  }

  const filasDevoluciones = [];
  for (const s of surtidos) {
    for (const d of s.devoluciones || []) {
      for (const p of d.productos || []) {
        filasDevoluciones.push({
          Folio: s.folio || "",
          Cliente: s.nombreCliente || "",
          "Fecha devolución": d.fechaLocal || d.fechaISO || "",
          Motivo: d.motivo || "",
          Observaciones: d.observaciones || "",
          Clave: p.clave || "",
          Producto: p.nombre || "",
          "Cantidad devuelta": Number(p.cantidadDevuelta || 0),
          "Importe ajuste": Number(p.cantidadDevuelta || 0) * Number(p.costo || 0),
          "Estatus de devolución": textoEstatusRevision(d.estatusRevision),
          "Registrada en el sistema": d.registradoSistema ? "Sí" : "No"
        });
      }
    }
  }

  const filasPagos = [];
  for (const s of surtidos) {
    for (const pago of pagosPedido(s)) {
      filasPagos.push({
        Folio: s.folio || "",
        Cliente: s.nombreCliente || "",
        Fecha: pago.fecha || "",
        Método: metodoPagoTexto(pago.metodo),
        Importe: Number(pago.monto || 0),
        "Estatus actual": textoPago(s.estatusPago),
        "Saldo actual": saldoPendiente(s)
      });
    }
  }

  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filasPedidos), "Pedidos");
  XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filasProductos), "Productos");
  XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filasPagos.length ? filasPagos : [{ Folio: "" }]), "Pagos");
  XLSX.utils.book_append_sheet(libro, XLSX.utils.json_to_sheet(filasDevoluciones.length ? filasDevoluciones : [{ Folio: "" }]), "Devoluciones");
  XLSX.writeFile(libro, `pedidos-${fechaSoloDia()}.xlsx`);
}

document.addEventListener("click", e => {
  const id = e.target.dataset.close;
  if (id) document.getElementById(id).close();
});

function actualizarCamposEntrega() {
  const tipo = document.querySelector('input[name="tipoEntrega"]:checked')?.value || "";
  const esPunto = tipo === "PUNTO_ENTREGA";
  const esDomicilio = tipo === "DOMICILIO";

  $("#campoPuntoEntrega").classList.toggle("hidden", !esPunto);
  $("#campoDomicilio").classList.toggle("hidden", !esDomicilio);
  $("#campoCostoEnvio").classList.toggle("hidden", !esDomicilio);
  $("#puntoEntrega").required = esPunto;
  $("#ubicacion").required = esDomicilio;
  $("#costoEnvio").required = esDomicilio;

  if (!esPunto) $("#puntoEntrega").value = "";
  if (!esDomicilio) {
    $("#ubicacion").value = "";
    $("#costoEnvio").value = "0";
  }

  actualizarTotalNuevo();
}

document.querySelectorAll('input[name="tipoEntrega"]').forEach(control =>
  control.addEventListener("change", actualizarCamposEntrega)
);

$("#costoEnvio").addEventListener("input", actualizarTotalNuevo);

$("#estatusPago").addEventListener("change", () => {
  const valor = $("#estatusPago").value;
  const apartado = valor === "APARTADO";
  const hayPago = valor === "APARTADO" || valor === "PAGADO";

  $("#campoMontoApartado").classList.toggle("hidden", !apartado);
  $("#campoMetodoPago").classList.toggle("hidden", !hayPago);
  $("#campoFechaPago").classList.toggle("hidden", !hayPago);
  $("#montoApartado").required = apartado;
  $("#metodoPagoInicial").required = hayPago;
  $("#fechaPagoInicial").value = hayPago ? fechaSoloDia() : "";

  if (!apartado) $("#montoApartado").value = "";
});

function configurarEstadosIniciales(tipoOperacion) {
  const selector = $("#estadoInicial");
  selector.innerHTML = "";

  const opciones = tipoOperacion === "BAZ"
    ? [
        ["CLASIFICADO", "Clasificado"],
        ["ENTREGADO", "Entregado"],
        ["FINALIZADO", "Finalizado"]
      ]
    : [
        ["EN_PROCESO", "En proceso"],
        ["ENVIADO", "Enviado"]
      ];

  for (const [valor, texto] of opciones) {
    const opcion = document.createElement("option");
    opcion.value = valor;
    opcion.textContent = texto;
    selector.appendChild(opcion);
  }
}

function abrirNuevoPedido(tipoOperacion) {
  $("#formSurtido").reset();
  $("#tipoOperacion").value = tipoOperacion;
  $("#fechaPedido").value = fechaSoloDia();

  const esVentaRapida = tipoOperacion === "VR";
  $("#modalSurtidoTitulo").textContent =
    tipoOperacion === "ALM"
      ? "Nuevo pedido de almacén"
      : tipoOperacion === "BAZ"
        ? "Nuevo pedido de bazar"
        : "Nueva venta rápida";

  configurarEstadosIniciales(tipoOperacion);

  $("#bloqueTipoEntrega").classList.toggle("hidden", esVentaRapida);
  $("#campoPuntoEntrega").classList.add("hidden");
  $("#campoDomicilio").classList.add("hidden");
  $("#campoCostoEnvio").classList.add("hidden");
  $("#costoEnvio").value = "0";
  $("#costoEnvio").required = false;
  $("#campoEstadoInicial").classList.toggle("hidden", esVentaRapida);

  $("#estadoInicial").required = !esVentaRapida;
  $("#puntoEntrega").required = false;
  $("#ubicacion").required = false;

  productosNuevo = [];
  renderProductosNuevo();
  actualizarTotalNuevo();

  $("#campoMontoApartado").classList.add("hidden");
  $("#campoMetodoPago").classList.add("hidden");
  $("#campoFechaPago").classList.add("hidden");
  $("#fechaPagoInicial").value = fechaSoloDia();
  mostrarMensajeProducto("");

  modalSurtido.showModal();
  setTimeout(() => $("#productoClave").focus(), 100);
}

$("#btnAlmacen").addEventListener("click", () => abrirNuevoPedido("ALM"));
$("#btnBazar").addEventListener("click", () => abrirNuevoPedido("BAZ"));
$("#btnVentaRapida").addEventListener("click", () => abrirNuevoPedido("VR"));

$("#btnReporteCaja").addEventListener("click", abrirReporteCaja);
$("#btnExportar").addEventListener("click", exportarPedidos);
$("#periodoCaja").addEventListener("change", () => {
  actualizarCamposPeriodoCaja();
  consultarCaja();
});
$("#metodoCaja").addEventListener("change", consultarCaja);
$("#btnAplicarCaja").addEventListener("click", consultarCaja);
$("#btnExportarCaja").addEventListener("click", exportarCaja);
$("#btnImprimirCaja").addEventListener("click", imprimirCaja);
$("#btnAgregarProducto").addEventListener("click", agregarProducto);
$("#productoClave").addEventListener("keydown", manejarLecturaCodigo);
$("#productoClave").addEventListener("change", () => buscarProductoCatalogo());
$("#productoClave").addEventListener("blur", () => {
  if ($("#productoClave").value.trim() && !$("#productoNombre").value.trim()) {
    buscarProductoCatalogo();
  }
});
$("#productoClave").addEventListener("input", () => {
  mostrarMensajeProducto("");
});
$("#btnGuardarBorrador").addEventListener("click", () => guardarPedido(false));
$("#btnFinalizarNuevo").addEventListener("click", () => guardarPedido(true));
$("#cambiarEstado").addEventListener("change", actualizarConfirmacionInventarioPorEstado);
$("#btnCambiarEstado").addEventListener("click", cambiarEstado);
$("#btnAgregarPago").addEventListener("click", abrirPago);
$("#formPago").addEventListener("submit", guardarNuevoPago);
$("#btnAbrirDevolucion").addEventListener("click", abrirDevolucion);
$("#btnImprimir").addEventListener("click", () => imprimirEtiqueta(surtidoActual));
$("#formDevolucion").addEventListener("submit", guardarDevolucion);
$("#buscador").addEventListener("input", renderLista);
$("#filtroEstado").addEventListener("change", renderLista);
$("#filtroPago").addEventListener("change", renderLista);
$("#filtroMetodo").addEventListener("change", renderLista);
$("#filtroDevolucion").addEventListener("change", renderLista);

$("#formLogin").addEventListener("submit", iniciarSesion);
const btnEscanearCodigo = $("#btnEscanearCodigo");
const btnCerrarEscaner = $("#btnCerrarEscaner");
const btnCancelarEscaner = $("#btnCancelarEscaner");
const modalEscaner = $("#modalEscaner");

if (btnEscanearCodigo) {
  btnEscanearCodigo.addEventListener("click", iniciarEscaner);
}

if (btnCerrarEscaner) {
  btnCerrarEscaner.addEventListener("click", cerrarEscaner);
}

if (btnCancelarEscaner) {
  btnCancelarEscaner.addEventListener("click", cerrarEscaner);
}

if (modalEscaner) {
  modalEscaner.addEventListener("close", detenerEscaner);
}

cargarCatalogoProductos();
configurarEscanerMovil();
