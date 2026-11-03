// Restaura una copia de seguridad en una base NUEVA (nunca pisa la actual).
// 1) Bajá de Cloudinary (carpeta "backups-sistema") todas las partes de UNA copia (mismo "copia-AAAAMMDDhhmmss-…") a una carpeta.
// 2) Corré:  BACKUP_CLAVE="la-clave" MONGODB_URI="mongodb+srv://…" node restaurarCopia.js ./carpeta-con-las-partes [nombre_base_nueva]
// La base nueva se llama restaurada_AAAAMMDD si no se indica otro nombre. Después se revisa y, si está bien, se pasan los datos
// a la base de producción (o se apunta MONGODB_URI/DB_NAME a la restaurada). Esto lo conviene hacer con ayuda.
const fs = require('fs'), path = require('path');
const { MongoClient } = require('mongodb');
const { restaurar } = require('./backup');
(async () => {
  const [carpeta, nombreBase] = process.argv.slice(2);
  if (!carpeta || !process.env.BACKUP_CLAVE || !process.env.MONGODB_URI) { console.error('Uso: BACKUP_CLAVE=… MONGODB_URI=… node restaurarCopia.js <carpeta> [nombre_base_nueva]'); process.exit(1); }
  const partes = fs.readdirSync(carpeta).filter(f => f.endsWith('.bin')).sort().map(f => fs.readFileSync(path.join(carpeta, f)));
  if (!partes.length) { console.error('No hay archivos .bin en la carpeta.'); process.exit(1); }
  const destino = nombreBase || 'restaurada_' + new Date().toISOString().slice(0, 10).replace(/-/g, '');
  if (destino === 'calculadora_m2') { console.error('Por seguridad no se restaura sobre la base en uso (calculadora_m2). Elegí otro nombre.'); process.exit(1); }
  const c = await new MongoClient(process.env.MONGODB_URI).connect();
  const r = await restaurar(partes, c.db(destino), process.env.BACKUP_CLAVE);
  console.log('Restauradas', Object.keys(r).length, 'colecciones y', Object.values(r).reduce((a, b) => a + b, 0), 'documentos en la base', destino);
  await c.close();
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
