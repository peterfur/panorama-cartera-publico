# Panorama de Cartera

Panel local para seguir una cartera repartida entre **DEGIRO** e **Interactive Brokers**: valor, aportaciones, rentabilidad (TIR), dividendos, resultado realizado y evolución de la operativa.

Es una aplicación que se ejecuta en tu ordenador. Los datos están en un archivo de esta carpeta (`data/portfolio.json`), nada se envía a ningún servidor y funciona sin conexión; internet solo hace falta si quieres que busque los precios por ti.

> **Este repositorio contiene datos financieros personales. Mantenlo privado.**

## Arrancar

No hace falta instalar nada a mano: la aplicación no tiene dependencias y, si no tienes [Node.js](https://nodejs.org) 18 o superior en tu ordenador, el propio lanzador descarga automáticamente una copia oficial y portable de Node.js LTS dentro de esta carpeta (`.runtime/node/`, verificada con SHA-256, sin permisos de administrador y sin tocar el sistema). Solo hace falta conexión a internet esa primera vez.

| Sistema | Cómo |
| --- | --- |
| Windows | Doble clic en `iniciar.bat` |
| macOS | Doble clic en `iniciar.command` |
| Linux | `./iniciar.command` en una terminal abierta en esta carpeta |
| Cualquiera (si ya tienes Node.js) | `npm start` en una terminal abierta en esta carpeta |

Se abre el navegador en `http://localhost:8765`. Para cerrar la aplicación, cierra la ventana de la terminal o pulsa `Ctrl+C` en ella.

> **Avisos del sistema la primera vez (al descargar un ZIP de internet):**
> - **Windows:** si aparece el aviso azul de Windows SmartScreen (*«Windows protegió su PC»*), pulsa **Más información → Ejecutar de todas formas**.
> - **macOS:** si al abrir `iniciar.command` el sistema bloquea el script, haz clic derecho → **Abrir** (o ejecuta `chmod +x iniciar.command` en Terminal).

### Actualizar a una nueva versión

Para actualizar a una versión nueva de Panorama de Cartera sin perder nada, **conserva tu carpeta `data/`, tu `config.json` y tu `.env`** (y opcionalmente `.runtime/` para no volver a bajar Node.js), y sustituye el resto de archivos del programa por los de la nueva versión.

## Qué se puede hacer

**Moverse por la página.** La barra de arriba se queda fija al bajar: lleva a cada sección (marca en la que estás) y, en «Acciones», abre las mismas ventanas que los botones de la cabecera.

**Ver la distribución.** Una rueda con el peso de cada valor sobre el total de las posiciones de las dos cuentas (un valor que está en los dos brókers sale una sola vez, sumado). Al pasar el ratón por un sector o por su fila sale el detalle: títulos, precio, valor, coste y plusvalía. Los ocho primeros valores llevan un color propio; del noveno en adelante se repiten los colores con rayas.

**Compararte con los índices.** La sección «Evolución frente a los índices» calcula qué valdría tu dinero si cada aportación y cada retirada se hubiera hecho el mismo día en el S&P 500 o en el Nasdaq-100 (con los fondos SPY y QQQ, dividendos reinvertidos, en euros). Compara el valor de hoy, la ganancia y la TIR, y lo dibuja desde la primera aportación. Los botones **1 D, 1 S, 1 M, 3 M, 6 M, 1 A, 3 A y Total** muestran ese periodo con todas las líneas empezando en 0 €: cuánto ha ganado cada una desde ese día sin contar lo aportado, y la rentabilidad del periodo en %. La línea de tu cartera tiene un punto por cada día en que guardas algo (al actualizar precios, por ejemplo), así que se va completando sola: no hay precios históricos de todos los valores que has tenido.

El histórico semanal de los índices se descarga con «Actualizar índices» (6 consultas de Alpha Vantage) y se guarda en `data/indices.json`, así que después funciona sin conexión. Para ver de cerca un día o una semana hacen falta también los cierres diarios: llegan con ese mismo botón y, además, cada vez que pulsas «Actualizar precios» (3 consultas más), y se van acumulando. Los índices se pueden cambiar o ampliar en `config.json`, con una lista `benchmarks` como `[{"id":"msci","name":"MSCI World","symbol":"URTH","cur":"USD"}]`.

**Importar extractos de los dos brókers.** El botón «Importar extractos» admite uno o varios CSV a la vez, de DEGIRO y de Interactive Brokers, y con ellos se actualizan todos los apartados: posiciones, coste, resultado realizado, dividendos, comisiones, intereses, aportaciones, gráficos y TIR. Antes de guardar enseña qué apuntes son nuevos y cómo cambian las cifras. Los detalles están más abajo, en «Importar extractos».

**Actualizar precios.** El extracto de DEGIRO no trae cotizaciones, así que el valor de las posiciones depende de los precios que se guarden. El botón «Actualizar precios» abre una ventana con una casilla por posición y por divisa. Sin clave de Alpha Vantage se rellenan a mano. Con clave, la aplicación busca sola las que tienen símbolo configurado y deja editables las demás. Al guardar se recalculan valor, plusvalías, totales y TIR.

**Registrar movimientos de DEGIRO a mano.** Compra, venta, dividendo, aportación, retirada, comisión e interés, para apuntar algo reciente sin esperar al siguiente extracto. Cuando después importas un extracto que cubre esa fecha, el apunte a mano se sustituye por el del extracto y no se cuenta dos veces.

**Exportar un informe.** «Exportar informe» genera un único documento con toda la cartera en tablas (resumen, posiciones con su peso, exposición por divisa, dividendos, resultado realizado, aportaciones, costes, operativa, simulación fiscal IRPF y, si quieres, todas las operaciones), con las fechas de los datos y cómo se calcula cada cifra. Sirve para guardarlo, imprimirlo o dárselo a una IA para que analice la cartera. Sale en tres formatos con el mismo contenido: HTML (un archivo autónomo, sin scripts ni recursos externos), PDF (el mismo HTML desde el cuadro de imprimir del navegador, eligiendo «Guardar como PDF») y texto en Markdown para pegarlo en un chat. Por defecto oculta tu nombre y el número de cuenta; los ISIN, los importes y las fechas sí van.

**Simulación fiscal del IRPF (España).** La sección «Simulación fiscal del IRPF» calcula de forma orientativa la Base Imponible del Ahorro (territorio común) por ejercicio fiscal aplicando el método **FIFO global por ISIN** uniendo DEGIRO e Interactive Brokers, la **regla antiaplicación de los 2 meses** sobre pérdidas (con alertas activas y rastreo de liberaciones), la compensación cruzada del 25 % con dividendos, el arrastre durante 4 años y la escala del ahorro (2023–2024 y 2025+). Incluye además un simulador interactivo «¿Y si vendo hoy?» para estimar el impacto fiscal antes de vender.

**Comprobaciones.** Medio centenar de comprobaciones comparan cada cifra guardada con la misma cifra recalculada por otro camino (que el valor total sea la suma de las posiciones, que las aportaciones coincidan con los flujos fechados que usa la TIR, que el monedero se parezca al efectivo implícito…). Se ejecutan al abrir la página y antes de cada guardado: un cambio que rompa la coherencia no se guarda. Desde la terminal: `npm run check`.

**Historial y deshacer.** Cada guardado queda anotado con fecha y descripción, deja una copia del estado anterior en `data/backups/` y, si la carpeta es un repositorio git, hace un commit. «Deshacer el último cambio» vuelve al estado anterior.

## Importar extractos

Qué exportar en cada bróker, siempre en CSV y con la web en español:

| Bróker | Dónde | Qué fechas |
| --- | --- | --- |
| DEGIRO | Actividad → Estado de cuenta → Exportar → CSV | La primera vez, desde la apertura de la cuenta. Después, cualquier tramo que empiece antes de la última fecha ya importada. |
| Interactive Brokers | Rendimiento e informes → Extractos → Actividad → CSV | IBKR no deja más de un año por informe: exporta los que hagan falta hasta cubrir desde la apertura. |

**No se repite nada aunque las fechas se solapen.** La aplicación guarda un libro con todos los apuntes importados (`data/degiro-movimientos.csv` y `data/ibkr-extractos.json`). En DEGIRO, cada fila se reconoce por su fecha, hora, importe, saldo resultante e identificador de orden; en IBKR, cada operación, dividendo, retención, depósito y comisión se reconoce por su fecha, importe y valor. Volver a subir el mismo archivo, o uno que pise fechas ya importadas, solo añade lo que falte.

**No se aceptan huecos.** Si entre lo importado y el archivo nuevo quedan fechas sin cubrir, la aplicación lo detecta (en DEGIRO porque el saldo no encadena; en IBKR por los periodos de los informes) y no importa hasta que subas el tramo que falta.

**Todo se recalcula desde el libro completo**, no se va sumando encima. Por eso las cifras no dependen del orden ni del número de veces que importes. Lo único que no viene en ningún extracto son los precios de mercado de DEGIRO: se conservan los guardados y se actualizan con «Actualizar precios».

De Interactive Brokers, las posiciones, el efectivo y el valor de la cuenta son los del informe que termina más tarde. Aportaciones, dividendos, retenciones, comisiones y resultado realizado se suman entre informes. La TIR de IBKR la calcula la aplicación con el mismo método que la de DEGIRO; la rentabilidad ponderada que da IBKR se muestra aparte, informe a informe.

Los CSV originales no hace falta conservarlos. Si los guardas en la carpeta `extractos/`, git los ignora.

## Precios automáticos con Alpha Vantage

1. Pide una clave gratuita en <https://www.alphavantage.co/support/#api-key>.
2. Pulsa «Actualizar precios», pega la clave en el recuadro y pulsa «Guardar clave».

La clave se guarda en el archivo `.env` de esta carpeta, que está en `.gitignore` y no se sube a GitHub. También puedes escribirla directamente en el archivo `.env` de esta carpeta.

El plan gratuito permite unas 25 consultas al día (1 por cada divisa en `autoFx`, 1 por cada valor con símbolo configurado y 3 opcionales para los cierres diarios de los índices). Si se alcanza el límite o no hay conexión, la ventana lo dice y deja completar a mano.

Qué símbolo se consulta para cada valor está en `config.json`, por ISIN:

```json
"US5949181045": { "symbol": "MSFT", "cur": "USD", "label": "Nasdaq: MSFT" }
```

`cur` es la divisa en la que cotiza **ese símbolo**, que puede no ser la de tu línea en DEGIRO: si un valor no está en la bolsa donde lo compraste, se puede consultar en otra (por ejemplo, el Nasdaq en dólares). Para bolsas europeas, Alpha Vantage usa sufijos como `.AMS` (Ámsterdam), `.DEX` (Xetra) o `.FRK` (Fráncfort). Los valores sin símbolo, o de bolsas que el plan gratuito no cubre (Estocolmo, Australia…), se introducen a mano. En `autoFx` están las divisas cuyo tipo de cambio se busca solo; añadir divisas adicionales gasta una consulta más por divisa y actualización.

## Git y GitHub

Para que cada cambio quede versionado:

1. Instala [Git](https://git-scm.com/downloads).
2. Crea en <https://github.com/new> un repositorio **privado** y **vacío** (sin README, sin `.gitignore`, sin licencia).
3. En Windows, doble clic en `configurar-git.bat` y pega la dirección del repositorio cuando la pida (solo la primera vez). En otros sistemas:

   ```sh
   git init -b main
   git add -A
   git commit -m "Estado inicial de la cartera"
   git remote add origin https://github.com/TU-USUARIO/panorama-cartera.git
   git push -u origin main
   ```

Si más adelante cambian los archivos de la aplicación (una versión nueva), vuelve a ejecutar `configurar-git.bat` para subirlos.

A partir de ahí, cada guardado hace un commit con solo los archivos de datos (`data/portfolio.json`, los dos libros de extractos) y `config.json`, con mensajes como `movimiento: Compra de 10 × Microsoft Corporation a 420,00 USD (3.850,00 € con comisión)`. Los commits se quedan en tu ordenador hasta que hagas `git push`; si prefieres que se suban solos, pon `"autoPush": true` en `config.json`. Con `"autoCommit": false` la aplicación no toca git.

`git log -p data/portfolio.json` enseña qué cifra cambió en cada guardado.

## Con una sola cuenta, o desde cero

La aplicación funciona con DEGIRO, con Interactive Brokers o con las dos. En una instalación nueva arranca con la cartera vacía y una pantalla de bienvenida: se importan los extractos y se calcula todo. Lo que no aplica a la cuenta que tengas se oculta (por ejemplo, con solo IBKR no aparecen «Actualizar precios», «Registrar movimiento», el resultado realizado ni la operativa, que son de DEGIRO).

Tras la primera importación de DEGIRO, cada posición está valorada al precio de su última compra o venta, porque el extracto no trae cotizaciones: un aviso lo recuerda hasta que pulses «Actualizar precios».

## Dársela a otra persona

`crear-copia-para-compartir.bat` (o `npm run copia`) crea, al lado de esta carpeta, `panorama-cartera-para-compartir`: el programa **sin ningún dato tuyo** (ni `data/`, ni `.env` con tu clave, ni `extractos/`, ni `.runtime/`, ni el historial de git, ni las pruebas, que usan una copia de tus datos), con un `config.json` vacío. Comprímela y pásala. Quien la reciba solo tiene que abrir `iniciar.bat` (o `iniciar.command` en macOS/Linux) —si no tiene Node.js, se prepara automáticamente en modo portable la primera vez— e importar sus extractos; si quiere usar git, que cree su propio repositorio.

No compartas esta carpeta tal cual ni des acceso a tu repositorio de GitHub: contienen tu cartera completa.

## Archivos

```
server.js              servidor local: sirve la página y guarda los cambios
lib/calc.js            recálculo de todo lo derivado (valor, plusvalías, totales, TIR)
lib/movements.js       qué cambia cada tipo de movimiento
lib/checks.js          las comprobaciones
lib/degiro.js          extracto de DEGIRO: lectura, libro sin repetidos y reconstrucción
lib/ibkr.js            informes de Interactive Brokers: lo mismo
lib/rebuild.js         junta los dos libros y los movimientos a mano
lib/report.js          el informe exportable (HTML, PDF y texto)
lib/benchmark.js       comparación con los índices
lib/irpf.js            simulación fiscal del IRPF en España (FIFO y regla de los 2 meses)
lib/store.js           lectura y escritura en disco, copias de seguridad, git
lib/alphavantage.js    consulta de precios y tipos de cambio
public/                la página (HTML, CSS, JavaScript y fuentes; sin recursos externos)
data/portfolio.json    LOS DATOS que pinta el panel
data/degiro-movimientos.csv   libro de DEGIRO (aparece al importar el primer extracto)
data/ibkr-extractos.json      libro de Interactive Brokers (ídem)
data/indices.json             histórico de los índices: semanal y cierres diarios recientes
config.json            titular, símbolos de Alpha Vantage, ajustes de git
test/                  pruebas (npm test)
scripts/               comprobaciones desde la terminal e importación del panel antiguo
```

## Cómo se calcula

- **Coste de una posición**: suma de lo pagado en euros en cada compra, comisiones incluidas. Al vender se da de baja la parte proporcional (coste medio).
- **Rendimiento de DEGIRO**: resultado realizado + plusvalía no realizada + dividendos netos + intereses + comisiones que no son de compraventa. Las de compraventa no se restan otra vez porque ya están dentro del coste.
- **TIR**: tasa interna de retorno de las aportaciones y retiradas en sus fechas, con el patrimonio actual como flujo final en la fecha de la última actualización de precios. Las fechas se toman a medianoche, sin hora.
- **Valor total de la cartera**: aportaciones netas + rendimiento total. El valor de Interactive Brokers es el de su extracto.

## Límites conocidos

- **Los extractos tienen que estar en español y en CSV.** Con la web del bróker en otro idioma cambian los nombres de las columnas y la aplicación no los reconoce (lo dice al intentar importarlos).
- **Tipos de movimiento que no conozca.** Si DEGIRO introduce un tipo de apunte nuevo (un cambio de ISIN, un derecho de suscripción, un desdoblamiento), no se cuenta y aparece un aviso al importar y en las comprobaciones. Los desdoblamientos de Interactive Brokers sí quedan reflejados, porque sus posiciones se toman del informe.
- **Interactive Brokers solo en euros como divisa base.**
- **Dividendos de DEGIRO en otra divisa**: se pasan a euros con el tipo de cambio de su conversión en el propio extracto. Si el extracto termina antes de que DEGIRO los convierta, se estiman y se marcan con ≈ hasta el siguiente extracto.
- **Los precios de DEGIRO no vienen en los extractos.** Tras importar, el valor de las posiciones usa los últimos precios guardados hasta que los actualices.

## Pruebas

```sh
npm test         # cálculo, movimientos, importación de extractos, servidor, git
npm run check    # comprobaciones sobre los datos reales
```

Las pruebas trabajan sobre copias temporales y extractos inventados (`test/extractos.js`): no leen ni modifican tus datos.
