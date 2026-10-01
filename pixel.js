// Pixel-art logos for the map buttons, drawn from text grids ('#' = lit pixel, '.' = empty).
// They take the button's text color, so on/off styling keeps working.
(() => {
  const G = {
    btnRoads: ['.....#.....', '....#.#....', '....#.#....', '...#.#.#...', '...#.#.#...', '..#..#..#..', '..#.....#..', '.#...#...#.', '.#.......#.', '###########'],
    // satellite dish: a bowl facing up-right, a feed arm to the receiver, signal ticks, on a stand
    btnRadar: ['........##.', '#.....##..#', '#.....##..#', '#....#.....', '.#..#......', '..##.......', '...#.......', '....###....', '.....#.....', '.....#.....', '...#####...'],
    // snowflake: straight arms end in a three-prong fork (tip plus two prongs just below it); diagonals in a small fork
    btnFx: ['.....#.....', '..#.###.#..', '.##..#..##.', '...#.#.#...', '.#..###..#.', '###########', '.#..###..#.', '...#.#.#...', '.##..#..##.', '..#.###.#..', '.....#.....'],
    btnVessels: ['.....#.....', '.....##....', '.....#.....', '..######...', '..#....#...', '###########', '.#.......#.', '..#######..'],
    btnAir: ['.....#.....', '....###....', '....###....', '...#####...', '.#########.', '###########', '.....#.....', '.....#.....', '....###....', '...#####...'],
    btnBus: ['.#######.', '#.......#', '#.......#', '#########', '#.......#', '#.#...#.#', '#.......#', '.#######.', '.#.....#.'],
    btnLocate: ['....#....', '..#####..', '.#.....#.', '.#.###.#.', '##.###.##', '.#.###.#.', '.#.....#.', '..#####..', '....#....'],
    btnCompass: ['....#....', '...###...', '...###...', '..#####..', '..#####..', '.###.###.', '.##...##.', '##.....##', '#.......#']
  };
  const svg = (rows) => {
    const h = rows.length, w = Math.max(...rows.map((r) => r.length)), s = Math.max(w, h) + 1;
    let cells = '';
    rows.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === '#') cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`; }));
    return `<svg class="btn-ic" viewBox="${-(s - w) / 2} ${-(s - h) / 2} ${s} ${s}" shape-rendering="crispEdges" aria-hidden="true"><g fill="currentColor">${cells}</g></svg>`;
  };
  for (const [id, rows] of Object.entries(G)) {
    const old = document.querySelector(`#${id} svg.btn-ic`);
    if (old) old.outerHTML = svg(rows);
  }
})();
