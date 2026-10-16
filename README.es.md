# dsh-file-transfer

[English](README.md) · [简体中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Español** · [Русский](README.ru.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH 0.2.0-rc.2 verified](https://img.shields.io/badge/DeepSeek%20Harness-0.2.0--rc.2%20verified-4dabf7)](https://github.com/deepseek-ai/deepseek-harness)
[![No build step](https://img.shields.io/badge/build-none-brightgreen)](#development)

**Descarga archivos desde la barra lateral de DSH Web y vuelve a subirlos al workspace — por una conexión remota, no solo en localhost.**

DeepSeek Harness incluye un árbol de archivos en la barra lateral con el que puedes explorar y previsualizar tu workspace, pero es de solo lectura en ambos sentidos. Este plugin agrega los dos controles que faltaban:

| | |
| --- | --- |
| ![La pestaña de archivos de la barra lateral derecha, con el control Upload junto al botón de recarga](docs/screenshot-files.png) | ![Un archivo de texto en previsualización, con el control Download en el encabezado de la vista previa](docs/screenshot-download.png) |
| **⬆ Upload** en el encabezado del árbol de archivos — envía los archivos seleccionados al workspace | **⬇ Download** en el encabezado de la vista previa — guarda el archivo abierto en tu equipo |

## Por qué existe

Si ejecutas el harness en una máquina sin entorno gráfico y llegas a él desde el navegador, te faltan dos cosas de todos los días:

- **No puedes sacar un archivo.** Nada en la barra lateral define `Content-Disposition`, así que un informe, un PDF o una imagen que estás previsualizando no se puede guardar. Terminas volviendo al host y copiándolo a mano: `scp`, una unidad compartida, una memoria USB.
- **No puedes meter un archivo.** El servicio de archivos del workspace expone `list` / `read` / `readBytes` / `stat` / `changes` y nada más. No hay ruta de escritura, así que un archivo que está en tu portátil tiene que subirse por otra vía antes de que el agente pueda tocarlo.

Este plugin es deliberadamente pequeño y se queda en la barra lateral: no inventa un explorador de archivos nuevo, sino que agrega las acciones de descarga y de carga al que ya usas.

## Características

**⬇ Download**

- Transmite el archivo en streaming: los bytes nunca se quedan en la memoria del host como un solo búfer.
- Soporta `HEAD` y un único `Range`, así que reanudar y sondear funcionan (`206 Partial Content`).
- `Content-Disposition: attachment` con un `filename*` de RFC 5987, para que los nombres en CJK y con emoji sobrevivan el viaje de ida y vuelta en lugar de llegar como `%E6%8A%A5...`.
- Tipo de contenido correcto según la extensión, además de `nosniff` y `no-store`.
- Sin techo de tamaño propio.

**⬆ Upload**

- Streaming de bytes en crudo directamente a disco: sin envoltorio multipart, sin base64, sin esa inflación del 33 %.
- Se escribe primero en un hermano `.dsh-part-*` y solo se renombra a su sitio cuando el stream termina, así que una carga interrumpida nunca puede dejar un archivo truncado bajo el nombre real.
- Nunca sobrescribe. Un segundo `report.pdf` pasa a ser `report-1.pdf`.
- Límite de tamaño opcional (`maxUploadBytes`) que rechaza los cuerpos demasiado grandes y limpia lo que dejó atrás.

**Ambas**

- Autenticadas por la propia capa Connection de DSH: una solicitud sin autenticar se rechaza con `401` antes de que se ejecute tu handler. Sin malabares con tokens CSRF ni un inicio de sesión aparte.
- Lista blanca de raíces, resolución con `realpath` y rechazo de symlinks que se escapan.
- Envoltorio de error conocido (`{ ok: false, error: { code, message } }`) con códigos estables legibles por máquina.

## Instalación

```sh
# from GitHub
dsh plugin --profile web add github:helixzz/dsh-file-transfer

# or from a local checkout
dsh plugin --profile web add /path/to/dsh-file-transfer
```

El paquete declara `dsh.bundle.patch`, así que `dsh plugin add` lo agrega por su cuenta a la pila de capas `dsh.profile.bundles` del perfil: no hay que editar `cordis.patch.yml` a mano.

Después, o bien reinicias el perfil:

```sh
systemctl --user restart deepseek-harness.service   # or however you run dsh web
```

…o, si tu perfil se ejecuta con `patchReload: live`, dejas que el loader tome el nuevo bundle y simplemente recargas la página. (Así está desplegado este plugin en la máquina para la que se escribió: sin necesidad de reiniciar.)

Abre una sesión, despliega la barra lateral derecha y elige la pestaña **file**. `⬆ Upload` está junto al botón de recarga. Abre cualquier archivo y `⬇ Download` aparece al lado del control de "abrir con".

## Detrás de un proxy inverso

Define un límite de tamaño de cuerpo acorde con tus cargas. Para nginx:

```nginx
client_max_body_size 100m;
```

No hace falta nada más. Aquí la autenticación no es tarea del proxy: las rutas se registran en el registro fetch de Connection de DSH, así que una solicitud sin sesión válida nunca llega al plugin:

```console
$ curl -o /dev/null -w '%{http_code}\n' \
    'http://127.0.0.1:3900/api/dsh-file-transfer/download?path=/etc/hostname'
401
```

## Configuración

Todas las opciones son opcionales. Sobrescríbelas desde tu propia capa de perfil en lugar de editar el patch incluido:

```yaml
- id: file-transfer
  config:
    roots: []            # allow-list of absolute roots; [] means unrestricted
    allowUpload: true
    allowOverwrite: false
    maxUploadBytes: 0    # 0 means no limit
```

| Opción | Predeterminado | Significado |
| --- | --- | --- |
| `roots` | `[]` | Cuando no está vacía, todo destino de descarga y de carga debe resolverse —symlinks incluidos— dentro de una de estas raíces. Cualquier otra cosa recibe `403 outside-roots`. |
| `allowUpload` | `true` | Ponlo en `false` para eliminar la ruta de carga por completo (`403 upload-disabled`). |
| `allowOverwrite` | `false` | Cuando está desactivado, nunca se reemplaza un nombre existente; en su lugar se usa un `name-N.ext` libre. |
| `maxUploadBytes` | `0` | Rechaza los cuerpos más grandes con `413 upload-too-large` y borra el archivo parcial. |

## API HTTP

Dos rutas, ambas bajo `/api/` y ambas requieren una Connection autenticada. Útiles desde una terminal, un script o un agente:

```sh
# download (streams to stdout; add -r 0-1023 for a range)
curl -O -J 'https://host/api/dsh-file-transfer/download?path=/abs/report.pdf'

# upload (raw bytes, no multipart envelope)
curl -X POST -H 'content-type: application/octet-stream' \
  --data-binary @report.pdf \
  'https://host/api/dsh-file-transfer/upload?dir=/abs/dir&name=report.pdf'
```

Una carga correcta responde:

```json
{ "ok": true, "value": { "path": "/abs/dir/report.pdf", "name": "report.pdf", "bytes": 20481 } }
```

Los fallos usan el mismo envoltorio que el resto del harness:

```json
{ "ok": false, "error": { "code": "outside-roots", "message": "path is outside the configured roots" } }
```

| Código | Estado | Significado |
| --- | --- | --- |
| `missing-path` | 400 | No hay parámetro de consulta `path` / `dir`. |
| `not-absolute` | 400 | La ruta era relativa. |
| `not-a-file` / `not-a-directory` | 400 | Tipo de entrada equivocado. |
| `invalid-name` | 400 | El nombre proporcionado quedó reducido a nada utilizable. |
| `not-found` | 404 | La ruta no existe. |
| `outside-roots` | 403 | Se resolvió fuera de las `roots` configuradas. |
| `upload-disabled` | 403 | `allowUpload: false`. |
| `name-exhausted` | 409 | Los 10 000 nombres candidatos ya estaban ocupados. |
| `upload-too-large` | 413 | El cuerpo superó `maxUploadBytes`. |
| `write-failed` | 500 | El host no pudo escribir el archivo. |

## Modelo de seguridad

- La **autenticación** viene del registro fetch de Connection, la misma costura que usa la ruta `/api/file` incluida de fábrica. Ninguna ruta es alcanzable de forma anónima.
- La **resolución de rutas** hace pasar toda ruta enviada por el navegador por `realpath`, así que los segmentos `..` y los symlinks se resuelven *antes* de la comprobación de `roots`. Un symlink que apunta fuera de una raíz permitida se rechaza, y una prueba unitaria lo verifica.
- Los **nombres de archivo** se reducen a un único segmento de ruta: `../../etc/passwd` pasa a ser `passwd` y aterriza dentro del directorio elegido. Verificado de extremo a extremo, no solo en una prueba unitaria.
- Las **escrituras** son atómicas desde el punto de vista del lector (`.dsh-part-*` y luego rename), y nunca pisan un archivo existente salvo que lo pidas.

El plugin se ejecuta con los privilegios del propio proceso del harness. `roots` es la perilla para ofrecer una superficie más acotada cuando el harness es compartido, y `allowUpload: false` desactiva la ruta de escritura por completo.

## Compatibilidad

Compilado y verificado contra `@deepseek-ai/dsh` **0.2.0-rc.2**.

El paquete **no declara `peerDependencies` a propósito**. Un rango de peer demasiado ajustado es justo lo que hace que la compuerta de versiones de DSH rechace un plugin que por lo demás funciona:

```console
dsh: installation rejected: Plugin <name> is incompatible with dsh 0.2.0-rc.2:
     peerDependencies {"@deepseek-ai/dsh-client-connection":"^0.1.0"}
```

Este plugin solo habla con el servicio `connection` y con módulos integrados de Node. También evita las importaciones de cliente de paquetes que se eliminaron en 0.2 (por ejemplo `@deepseek-ai/dsh-client-runtime`), porque una dependencia de cliente ausente hace que toda la mitad del navegador no llegue a activarse.

## Desarrollo

No hay paso de compilación. `lib/index.js` (la mitad host en ESM) y `lib/client.js` (un bundle CJS escrito a mano para el `__ModuleLoader__` del shell Web) son los artefactos publicados, y ambos están en el repositorio para que las instalaciones con `github:` funcionen sin un script prepare.

```sh
node --check lib/index.js && node --check lib/client.js
node --test test/host.test.mjs
```

Las pruebas unitarias ejercitan los handlers exportados con objetos `Request` estándar, así que los rangos, las disposiciones, la sanitización de nombres, la aplicación de las raíces, el comportamiento de sobrescritura, los límites de tamaño y los escapes por symlink se comprueban todos sin levantar un perfil. Ocho casos, sin necesidad de montar un arnés de fixtures.

## Hoja de ruta

- Descarga de directorios como un único ZIP.
- Carga en el directorio que el árbol muestra en ese momento (no solo en la raíz del workspace), además de arrastrar y soltar.
- Un control de descarga en las tarjetas de archivos entregados. Hoy `deliverables.file.actions` entrega una URL de acción interna en lugar de una ruta del sistema de archivos, así que esto necesita soporte del upstream.

## Contribuir

Los issues y pull requests son bienvenidos. Dos cosas que conviene saber antes de enviar uno:

- **Ejecuta las pruebas.** `node --test test/host.test.mjs` debe seguir en verde.
- **Mantén las traducciones sincronizadas.** El README existe en seis idiomas y todos pretenden describir el mismo plugin; si cambias el comportamiento, actualiza la traducción que puedas escribir y dilo en el PR, y las demás pueden seguir después.

Procura mantener la superficie pequeña. Todo el valor de este plugin está en hacer dos cosas de forma predecible sobre el explorador de archivos de DSH, no en convertirse en un IDE.

## Licencia

MIT
