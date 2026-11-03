const assert=require('assert');const {start}=require('./harness');
(async()=>{const h=await start(4130);const {db,ids,api}=h;
const C=String(ids.cliente);
const mk=async(p)=> (await api('POST','/api/ventas',{clienteId:C,tipoEntrega:'pendiente',tipoComprobante:'comprobante_x',items:[{productoId:String(ids.cem50),cantidad:1,precioUnitario:p}]})).data;
const v1=await mk(10000), v2=await mk(3000);
const saldo=async()=> (await api('GET',`/api/clientes/${C}/cuenta-corriente`)).data;
const s0=(await saldo()).saldo;
let r=await api('POST','/api/tesoreria/cobros-cuenta-cliente',{clienteId:C,tipoValor:'efectivo',monto:8000,cuentaTipo:'caja',cuentaId:String(ids.caja)}); assert.equal(r.status,200,JSON.stringify(r.data));
let cc=await saldo(); const mov=cc.movimientos.find(m=>m.origen==='cobro_cuenta'); assert(mov); assert.equal(cc.saldo,s0-8000);
let vp=(await api('GET',`/api/clientes/${C}/ventas-pendientes`)).data; assert(vp.find(x=>x._id===v1._id)&&vp.find(x=>x._id===v2._id));
r=await api('POST',`/api/clientes/${C}/imputar`,{movimientoId:String(mov._id),imputaciones:[{ventaId:v1._id,monto:9000}]}); assert.equal(r.status,400,'excede lo disponible');
r=await api('POST',`/api/clientes/${C}/imputar`,{movimientoId:String(mov._id),imputaciones:[{ventaId:v2._id,monto:3500}]}); assert.equal(r.status,400,'excede saldo de la factura');
r=await api('POST',`/api/clientes/${C}/imputar`,{movimientoId:String(mov._id),imputaciones:[{ventaId:v1._id,monto:5000},{ventaId:v2._id,monto:3000}]}); assert.equal(r.status,200,JSON.stringify(r.data)); assert.equal(r.data.sinImputar,0);
let a=await db.collection('ventas').find({numero:{$in:[v1.numero,v2.numero]},total:{$in:[10000,3000]}}).toArray();
const g=n=>a.find(x=>x.total===n); assert.equal(g(10000).saldoPendiente,5000); assert.equal(g(3000).saldoPendiente,0); assert.equal(g(10000).totalCobrado,5000);
assert.equal((await saldo()).saldo,s0-8000,'imputar no cambia la cuenta corriente');
r=await api('POST',`/api/clientes/${C}/imputar`,{movimientoId:String(mov._id),imputaciones:[{ventaId:v1._id,monto:1}]}); assert.equal(r.status,400,'ya no queda disponible');
// deshacer la 2da
r=await api('POST',`/api/clientes/${C}/desimputar`,{movimientoId:String(mov._id),idx:1}); assert.equal(r.status,200,JSON.stringify(r.data));
let vv=await db.collection('ventas').findOne({total:3000,'imputaciones.0':{$exists:true}}); assert.equal(vv.saldoPendiente,3000); assert.equal(vv.totalCobrado,0);
// anular el cobro: la factura 1 vuelve a deber todo
r=await api('POST',`/api/tesoreria/cobranzas/${mov._id}/anular`,{motivo:'x'}); assert.equal(r.status,200,JSON.stringify(r.data));
vv=await db.collection('ventas').findOne({total:10000,'imputaciones.0':{$exists:true}}); assert.equal(vv.saldoPendiente,10000); assert.equal(vv.totalCobrado,0);
assert.equal((await saldo()).saldo,s0);
console.log('OK');process.exit(0)})().catch(e=>{console.error(e);process.exit(1)});
