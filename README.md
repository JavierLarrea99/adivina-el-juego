# Adivina el Juego

Juego para jugar con amigos desde el navegador: sale una captura de un videojuego, tenéis 20 segundos y cuanto antes lo adivines más puntos te llevas. Gana el primero que llegue a 100.

**Jugar:** https://javierlarrea99.github.io/adivina-el-juego/

## Cómo se juega

1. Uno pone su apodo y pulsa **Crear partida**. Sale un código de 4 letras y un enlace.
2. Manda el enlace por WhatsApp. Los demás lo abren, ponen su apodo y entran.
3. El anfitrión elige los puntos para ganar, los segundos por ronda y qué juegos salen, y pulsa **Empezar**.
4. En cada ronda escribe el nombre del juego y elige de la lista. Vale con siglas o abreviaturas (`gta 5`, `rdr2`, `cs2`, `skyrim`).

Puntos por acierto: de 1 a 10 según el tiempo que quede, más 3 extra al primero en acertar y 1 al segundo. Hay 3 intentos por ronda. Si la captura es un menú o no se ve nada, se puede votar para saltarla.

## Cómo funciona

- `index.html` es toda la web. No hay servidor: la pestaña del anfitrión hace de servidor y los jugadores se conectan a ella con [PeerJS](https://peerjs.com/) (WebRTC). Si el anfitrión cierra la pestaña, la partida termina.
- `data/games.json` tiene unos 1.600 juegos de Steam con sus capturas. Lo genera `scripts/juegos.mjs` con la acción **Actualizar juegos** (`.github/workflows/juegos.yml`), que se ejecuta sola cada lunes y también se puede lanzar a mano desde la pestaña *Actions*. Usa SteamSpy para la lista de juegos más populares y la tienda de Steam para las capturas. No necesita ninguna clave.
- Las imágenes se cargan directamente desde los servidores de Steam.

Las capturas y los nombres son de sus respectivos autores. Proyecto sin ánimo de lucro para jugar entre amigos.
