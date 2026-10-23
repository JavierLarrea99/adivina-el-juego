# Adivina el Juego

Juego para jugar con amigos desde el navegador: sale una captura de un videojuego y cuanto antes lo adivines más puntos te llevas. Gana el primero que llegue a la meta.

**Jugar:** https://javierlarrea99.github.io/adivina-el-juego/

## Cómo se juega

1. Elige tu monstruito (toca el avatar para cambiarlo y elige color), pon tu apodo y pulsa **Crear partida**.
2. Manda el enlace por WhatsApp. Los demás lo abren, ponen su apodo y entran.
3. El anfitrión elige los puntos para ganar, los segundos por ronda, qué juegos salen y cómo se ve la captura, y pulsa **Empezar**.
4. En cada ronda escribe el nombre del juego y elige de la lista. Vale con siglas o abreviaturas (`gta 5`, `rdr2`, `botw`, `pokemon rojo`).

Puntos por acierto: de 1 a 10 según el tiempo que quede, más 3 extra al primero en acertar y 1 al segundo. Hay 3 intentos por ronda. Si la captura no vale, se puede votar para saltarla (y no vuelve a salir en el dispositivo del anfitrión).

### Modos de captura

- **Normal**: la captura entera.
- **Pixelada**: empieza muy pixelada y se va aclarando.
- **Zoom**: empieza muy cerca de un trozo y se va alejando.
- **Sorpresa**: cada ronda un modo al azar.

### Chat, sonido y extras

- Chat de partida con reacciones rápidas. Si alguien escribe la respuesta durante la ronda, el mensaje no se envía.
- Efectos de sonido para todo y música chill de fondo, generados en el propio navegador (no hay archivos de audio). Cada jugador ajusta el volumen en el botón del altavoz.
- Al final, podio y estadísticas: respuesta más rápida, mejor racha y más aciertos.
- Si a alguien se le corta la conexión (pantalla bloqueada, cambio de red), vuelve a entrar solo con sus puntos.

## Cómo funciona

- `index.html` y la carpeta `js/` son toda la web. No hay servidor: la pestaña del anfitrión hace de servidor y los jugadores se conectan a ella con [PeerJS](https://peerjs.com/) (WebRTC, incluido en `vendor/`). Si el anfitrión cierra la pestaña, la partida termina.
  - `js/anfitrion.js`: reglas de la partida (solo se ejecuta en la pestaña del anfitrión).
  - `js/app.js`: conexión, pantallas, chat y reacciones.
  - `js/datos.js`: lista de juegos y búsqueda.
  - `js/sonido.js`: efectos y música.
  - `js/avatar.js`: monstruitos de píxel.
- `data/games.json` tiene unos 4.000 juegos de Steam y de consolas (RAWG) con sus capturas. Lo genera la acción **Actualizar juegos** (`.github/workflows/juegos.yml`), que se ejecuta sola cada lunes y también se puede lanzar a mano desde la pestaña *Actions*:
  - `scripts/juegos.mjs` reúne los juegos más populares de Steam (SteamSpy + tienda de Steam) y de cada consola (RAWG, con la clave guardada en el secreto `RAWG_KEY`).
  - `scripts/revisar.py` revisa cada captura y quita las que no valen: menús, pantallas de título, logos, carátulas, pantallas de carga con texto, capturas con mucho texto y aquellas en las que se lee el nombre del juego (también en las esquinas). Usa un modelo de visión (CLIP) y un lector de texto (Tesseract).
- La acción **Probar filtro de capturas** revisa una muestra al azar y sube a la rama `revision` hojas con las capturas descartadas, para comprobar a ojo que el filtro no quita capturas buenas.

Las capturas y los nombres son de sus respectivos autores. Proyecto sin ánimo de lucro para jugar entre amigos.
