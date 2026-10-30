# Vía Libre

Puesto de mando de incidencias de **Cercanías** con **datos reales de Renfe**.

- Mapa con todos los trenes de cada núcleo (Madrid, Rodalies, Valencia, Sevilla, Bilbao…).
- Alertas automáticas: trenes parados fuera de estación, retrasos de más de 5 min, retrasos generalizados en una línea y trenes cancelados.
- Avisos oficiales que publica Renfe.
- Incidencias: ábrelas desde una alerta o un tren, cambia su estado y añade notas (se guardan en tu navegador).
- Patrones: qué líneas se retrasan más y a qué hora.

## Cómo funciona

Renfe publica sus datos en abierto ([GTFS‑RT](https://gtfsrt.renfe.com)), pero no deja que otras webs los lean directamente desde el navegador.
Por eso un robot de **GitHub Actions** (`.github/workflows/datos.yml`) hace esto cada 5 minutos:

1. Descarga posiciones, retrasos y avisos de Renfe (`scripts/update.mjs`).
2. Los guarda en `data/` junto a la web.
3. Publica todo en **GitHub Pages**.

No se guarda nada en el repo en cada ejecución, así que no crece.

Ojo: GitHub no garantiza el "cada 5 minutos"; a veces se retrasa y los datos pueden tener entre 5 y 15 minutos.
Si el repo pasa 60 días sin cambios, GitHub pausa el robot: se reactiva desde la pestaña **Actions**.

Datos: Renfe Open Data. Mapa: © OpenStreetMap, © CARTO.
