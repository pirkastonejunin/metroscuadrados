// ---------------------------------------------------------------------------
// Cálculo fiscal de un comprobante (5/10/2026, "parte fiscal") — SIN acceso
// a Mongo ni a ARCA, funciones puras para poder probarlas solas.
//
// Dado el detalle de una venta (ítems con su subtotal y % de IVA, descuento
// global y si los precios YA INCLUYEN el IVA o son netos) devuelve lo que
// necesita ARCA: neto e IVA por alícuota, y el total.
//
// Decisiones:
//   - El descuento (% y $) es global en las ventas: se reparte
//     proporcionalmente entre los ítems antes de discriminar el IVA.
//   - Precios que incluyen IVA: el total NO cambia (neto = bruto / (1+r)).
//     Precios netos: el IVA se suma encima y el total sube.
//   - Todo se redondea a centavos; las diferencias de redondeo se absorben
//     en el grupo de mayor importe para que neto + IVA == total exacto.
// ---------------------------------------------------------------------------

// Alícuotas que ARCA acepta en WSFE → Id de FEParamGetTiposIva.
const ALICUOTAS_ARCA = {
  0: 3,
  2.5: 9,
  5: 8,
  10.5: 4,
  21: 5,
  27: 6
};

function redondear2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

function idAlicuotaArca(porcentaje) {
  const p = Number(porcentaje);
  for (const k of Object.keys(ALICUOTAS_ARCA)) {
    if (Math.abs(Number(k) - p) < 1e-9) return ALICUOTAS_ARCA[k];
  }
  return null;
}

/**
 * @param {Object} p
 * @param {Array<{subtotal:number, porcentajeIva:number}>} p.items
 * @param {number} [p.descuentoPorcentaje]
 * @param {number} [p.descuentoMonto]
 * @param {boolean} p.preciosIncluyenIva
 * @param {boolean} [p.discriminaIva=true]  false para Factura C (no discrimina IVA)
 */
function calcularFiscal({ items, descuentoPorcentaje = 0, descuentoMonto = 0, preciosIncluyenIva, discriminaIva = true }) {
  if (!Array.isArray(items) || !items.length) throw new Error('No hay ítems para calcular');
  const subtotalBruto = items.reduce((a, it) => a + Number(it.subtotal || 0), 0);
  let conDescuento = subtotalBruto;
  if (descuentoPorcentaje) conDescuento -= conDescuento * (descuentoPorcentaje / 100);
  if (descuentoMonto) conDescuento -= descuentoMonto;
  conDescuento = Math.max(0, conDescuento);
  const factor = subtotalBruto > 0 ? conDescuento / subtotalBruto : 0;

  // 1) importe de cada ítem ya con el descuento repartido
  const lineas = items.map(it => {
    const p = Number(it.porcentajeIva);
    if (!Number.isFinite(p) || p < 0) throw new Error('Alícuota de IVA inválida en un ítem');
    if (idAlicuotaArca(p) === null) throw new Error(`La alícuota de IVA ${p}% no es una de las que acepta ARCA (0, 2.5, 5, 10.5, 21 o 27)`);
    return { porcentajeIva: p, importe: Number(it.subtotal || 0) * factor };
  });

  // 2) agrupar por alícuota
  const grupos = new Map();
  for (const l of lineas) {
    const g = grupos.get(l.porcentajeIva) || { porcentaje: l.porcentajeIva, bruto: 0 };
    g.bruto += l.importe;
    grupos.set(l.porcentajeIva, g);
  }

  const lista = [];
  if (!discriminaIva) {
    // Factura C: sin IVA discriminado, el neto es el total.
    const total = redondear2(conDescuento);
    return {
      preciosIncluyenIva: !!preciosIncluyenIva, discriminaIva: false,
      grupos: [], neto: total, iva: 0, total,
      items: lineas.map((l, i) => ({ porcentajeIva: 0, neto: redondear2(l.importe), iva: 0, total: redondear2(l.importe) }))
    };
  }
  for (const g of grupos.values()) {
    if (preciosIncluyenIva) {
      const brutoRed = redondear2(g.bruto);
      const neto = redondear2(g.bruto / (1 + g.porcentaje / 100));
      lista.push({ porcentaje: g.porcentaje, idArca: idAlicuotaArca(g.porcentaje), baseImp: neto, importe: redondear2(brutoRed - neto) });
    } else {
      const neto = redondear2(g.bruto);
      lista.push({ porcentaje: g.porcentaje, idArca: idAlicuotaArca(g.porcentaje), baseImp: neto, importe: redondear2(neto * g.porcentaje / 100) });
    }
  }

  // 3) total y ajuste de centavos (solo cuando el total tiene que ser el original)
  let neto = redondear2(lista.reduce((a, g) => a + g.baseImp, 0));
  let iva = redondear2(lista.reduce((a, g) => a + g.importe, 0));
  let total = redondear2(neto + iva);
  if (preciosIncluyenIva) {
    const totalEsperado = redondear2(conDescuento);
    const dif = redondear2(totalEsperado - total);
    if (Math.abs(dif) >= 0.01 && lista.length) {
      const mayor = lista.reduce((m, g) => (g.baseImp + g.importe > m.baseImp + m.importe ? g : m), lista[0]);
      mayor.baseImp = redondear2(mayor.baseImp + dif);
      neto = redondear2(lista.reduce((a, g) => a + g.baseImp, 0));
      total = redondear2(neto + iva);
    }
  }
  lista.sort((a, b) => a.porcentaje - b.porcentaje);

  // 4) detalle por ítem (para imprimir: precio neto y total con IVA por línea)
  const detalle = lineas.map(l => {
    const r = l.porcentajeIva / 100;
    if (preciosIncluyenIva) {
      const bruto = redondear2(l.importe);
      const netoL = redondear2(l.importe / (1 + r));
      return { porcentajeIva: l.porcentajeIva, neto: netoL, iva: redondear2(bruto - netoL), total: bruto };
    }
    const netoL = redondear2(l.importe);
    const ivaL = redondear2(l.importe * r);
    return { porcentajeIva: l.porcentajeIva, neto: netoL, iva: ivaL, total: redondear2(netoL + ivaL) };
  });

  return { preciosIncluyenIva: !!preciosIncluyenIva, discriminaIva: true, grupos: lista, neto, iva, total, items: detalle };
}

module.exports = { calcularFiscal, idAlicuotaArca, ALICUOTAS_ARCA, redondear2 };
