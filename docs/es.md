# InfluxDB

Lleve a Gladys las medidas que su [InfluxDB](https://www.influxdata.com/) ya
contiene — recogidas por Telegraf, un script, otra domótica: las consultas
que elija se convierten en sensores (la temperatura de cada habitación, la
potencia de un inversor solar, la energía del día), y sus escenas reaccionan
cuando InfluxDB deja de responder o una consulta falla. Un widget del panel
muestra los últimos valores de un vistazo.

La integración lee InfluxDB en su red local, o InfluxDB Cloud. Solo lee: no se
escribe nada en InfluxDB.

Probada con servidores reales InfluxDB 1.11, 2.9 y 3 Core 3.12 (imágenes
Docker oficiales, datos con varias series y etiquetas, consultas Flux,
InfluxQL y SQL, un token de solo lectura). InfluxDB Cloud usa la misma API, sin
probar. Sus comentarios son bienvenidos:
[github.com/guim31/gladys-influxdb/issues](https://github.com/guim31/gladys-influxdb/issues).

## Lo que necesita

- Gladys Assistant 5.1.0 o posterior.
- InfluxDB 1.x, 2.x, 3 Core o Enterprise, accesible desde la máquina de Gladys
  (puerto 8086, 8181 para InfluxDB 3), o una cuenta de InfluxDB Cloud.
- Un acceso:
  - InfluxDB 2 y Cloud: un **token de API** que pueda leer sus buckets, y el
    nombre de la **organización**;
  - InfluxDB 1: un usuario y una contraseña (si la autenticación está
    activa);
  - InfluxDB 3: un token (salvo si funciona sin autenticación).

## Primeros pasos

### 1. Configurar la integración

En Gladys, abra la configuración de la integración:

- **API y lenguaje de consulta**:
  - **InfluxDB 2 o Cloud (Flux)**: consultas en Flux;
  - **InfluxQL (InfluxDB 1, 2 o 3)**: consultas en InfluxQL. También funciona
    con InfluxDB 2 (su API de compatibilidad v1, el bucket como base) e
    InfluxDB 3;
  - **InfluxDB 3 (SQL)**: consultas en SQL.
- **Dirección de InfluxDB**: p. ej. `http://192.168.1.2:8086`. Un simple
  `192.168.1.2` toma el puerto 8086 (8181 para InfluxDB 3). La dirección de una
  página de la interfaz de InfluxDB 2 también sirve, y da la organización.
- **Organización (InfluxDB 2, Cloud)**: su nombre o su identificador.
- **Base de datos (InfluxQL, SQL)**: p. ej. `telegraf`; con InfluxDB 2, el
  nombre del bucket.
- **Token de API**: InfluxDB 2, Cloud y 3. Basta con un token de solo lectura.
- **Usuario (InfluxDB 1)**, **Contraseña (InfluxDB 1)**: InfluxDB 1 con
  autenticación. El token gana si ambos están rellenos.
- **Intervalo de actualización**: 1 minuto por defecto, de 30 segundos a
  10 minutos.
- **Aceptar certificados autofirmados**: solo para una dirección `https://`
  cuyo certificado tampoco reconoce su navegador.
- **Idioma de los mensajes**: el idioma de los resultados de escena y de los
  mensajes. Los nombres de las funciones vienen de sus etiquetas.

Haga clic en **Probar la conexión**: responde con la versión de InfluxDB y las
consultas, o con lo que falla.

### 2. Añadir sus consultas

También en la configuración, la acción **Añadir una consulta** pide:

- **Nombre**: el nombre del dispositivo, p. ej. `Temperaturas de las
habitaciones`. Añadir una consulta con el mismo nombre la sustituye (mismo
  dispositivo).
- **Consulta (Flux, InfluxQL o SQL)**: en el lenguaje de la API elegida. Debe
  dar un valor por serie: el último, una media… Por ejemplo:
  - InfluxQL: `SELECT last(value) FROM temperature WHERE time > now() - 1h GROUP BY room`;
  - Flux: `from(bucket: "home") |> range(start: -1h) |> filter(fn: (r) => r._measurement == "temperature") |> last()`;
  - SQL: `SELECT room, last_value(value ORDER BY time) AS value FROM temperature WHERE time > now() - INTERVAL '1 hour' GROUP BY room`.
- **Tipo**: lo que muestra Gladys. Número (sin unidad), Temperatura (°C),
  Humedad (%), Porcentaje (%), Potencia (W), Energía (kWh). Convierta en la
  consulta si hace falta (`/ 1000` para kWh a partir de Wh).
- **Etiqueta que nombra las series (opcional)**: cuando la consulta devuelve
  varias series, cada una se convierte en una función con el nombre de esta
  etiqueta (p. ej. `room`). Vacío: las etiquetas que cambian de una serie a
  otra.

La consulta se comprueba primero en InfluxDB: un error se responde con el
mensaje de InfluxDB, y no se guarda nada. **Eliminar una consulta** pide un
nombre.

Lo que forma una serie:

- **Flux**: una por tabla (la clave de grupo: etiquetas, `_measurement`,
  `_field`), su última fila. Tras un `pivot()`, cada columna numérica es su
  propia serie.
- **InfluxQL**: una por serie de la respuesta (etiquetas del `GROUP BY`), su
  última fila. `SELECT last(a), last(b)` da una serie por columna.
- **SQL**: las columnas de texto nombran las series, cada columna numérica es
  un valor; gana la primera fila de una serie (`ORDER BY time DESC`).

Los booleanos cuentan como 1 y 0; los valores de texto se ignoran. En SQL,
seleccione solo las columnas de texto que nombran una serie: un estado que cambia
crearía una serie nueva (las fechas escritas como texto se ignoran).

### 3. Añadir los dispositivos

Abra la pestaña **Descubrir** de la integración y añada los dispositivos que
quiera seguir.

## Los dispositivos

**Un dispositivo por consulta**, con una función por serie, 20 como máximo,
del tipo elegido. El nombre de una función se fija cuando la serie aparece por
primera vez, y Gladys lo conserva una vez añadido el dispositivo. Una serie
vista más tarde añade una función: Gladys propone entonces **Actualizar** en
la pestaña Descubrir. Una serie que desaparece conserva su función, sin
valores nuevos.

Un dispositivo se marca como inaccesible mientras InfluxDB no responde, y
conserva sus últimos valores. Su distintivo indica cloud para InfluxDB Cloud.

## Panel

El widget **Valores de InfluxDB** muestra el último valor de cada consulta,
una fila por serie con su unidad, o «Error» para una consulta que InfluxDB
rechaza. En sus ajustes, elija las consultas que mostrar (sus dispositivos);
vacío: todas. El botón **Actualizar** vuelve a leer InfluxDB.

## Escenas

### Disparadores

- **InfluxDB no está accesible**: fallan dos lecturas seguidas (sin
  respuesta, acceso denegado, organización o base no encontrada). Da el error,
  y su clave (`unreachable`, `auth`, `organization`, `database`…).
- **InfluxDB responde de nuevo**: tras el primer disparador, una lectura
  vuelve a funcionar. Da la duración de la caída en minutos.
- **Una consulta falla**: InfluxDB rechaza una consulta (sintaxis, bucket o
  tabla desconocidos, sin permisos), o su respuesta no tiene ningún número. Una vez, hasta que la consulta vuelva a funcionar.
  Filtro: el nombre de la consulta (vacío: cualquiera). Da el nombre de la
  consulta y el error.

Lo anunciado se conserva: un reinicio no lo anuncia dos veces, ni olvida decir
que InfluxDB ha vuelto. Una consulta sin datos por ahora no es un fallo.

### Acciones

- **Leer un valor de InfluxDB**: ejecuta una consulta una vez, sin crear un
  dispositivo. Resultados: el valor de la primera serie (0 si no hay ninguna),
  el número de series, y los valores como texto (`kitchen: 21.5, attic: 15.75`).

### Ideas de escenas

- **InfluxDB no está accesible** → enviar «InfluxDB: {error}» a su teléfono; y
  **InfluxDB responde de nuevo** → «InfluxDB ha vuelto tras {duración}
  minutos».
- Una temperatura del dispositivo «Temperaturas de las habitaciones» por
  encima de 26 °C → cerrar las persianas de esa habitación.
- Cada tarde → **Leer un valor de InfluxDB** con la energía del día
  (`SELECT sum(kwh) FROM solar WHERE time > now() - 1d`) y enviar «Solar hoy:
  {valor} kWh».

## Solución de problemas

- **«no responde»**: compruebe la dirección y el puerto desde la máquina de
  Gladys (`curl -i http://192.168.1.2:8086/ping`). Gladys ejecuta la
  integración en un contenedor en una red puente: `localhost` es el
  contenedor, no el host.
- **«acceso denegado»**: el token, o el usuario y la contraseña, se rechazan;
  o el token no puede leer ese bucket o esa base.
- **«organización no encontrada»**, **«base de datos no encontrada»**:
  compruebe el nombre en la configuración (InfluxDB 2: la organización del
  token).
- **«certificado rechazado»**: marque **Aceptar certificados autofirmados**.
- **«la dirección redirige»**: introduzca la dirección `https://`.
- **«no hay ninguna API de InfluxDB de la versión elegida en esta
  dirección»**: otro servicio responde allí, o la API elegida no es la del
  servidor (SQL necesita InfluxDB 3).
- **«el resultado no tiene ningún número»**: la consulta solo devuelve texto;
  elija un campo numérico.
- **Una consulta no muestra ningún valor**: **Probar la conexión** indica qué
  consulta no tiene datos por ahora. Pruébela en la interfaz de InfluxDB (Data
  Explorer), o con el comando `influx`.
- **Registros**: en Gladys, la página de la integración muestra sus registros.
  Añada `LOG_LEVEL=debug` para ver cada lectura.

## Límites

- 20 consultas, y 20 series por consulta. Una consulta se ejecuta en cada
  actualización: acótela en el tiempo (`WHERE time > now() - 1h`,
  `range(start: -1h)`) para que InfluxDB no recorra todo su historial cada
  minuto.
- Solo lectura: los estados de Gladys no pueden escribirse en InfluxDB desde
  una integración externa.
- Las consultas se guardan en el volumen de datos de la integración:
  reinstalarla desde cero las pierde (añádalas de nuevo con los mismos
  nombres: mismos dispositivos).
- Los valores se redondean a dos decimales.
- Una base (InfluxQL, SQL) por configuración; en InfluxQL, otra se lee por su
  nombre completo (`"db"."autogen"."measurement"`).
- InfluxDB Cloud: misma API, sin probar por falta de cuenta; tenga en cuenta
  las cuotas de lectura de su plan (una petición por consulta y por
  actualización).
- Probada con las herramientas de prueba del SDK de Gladys y servidores
  InfluxDB reales, aún no en una instancia real de Gladys: sus comentarios son
  bienvenidos.
