// Pixel-art icons drawn from text grids, all nose/front up (markers rotate them to their heading).
//   '#' outline in the icon's color · 'x' solid color (cabins, containers, wheelhouses) · 'o' dim fill · '.' empty
// htPix(name, color) returns an SVG sized to a square, so rotating it never clips.
(() => {
  const G = {
    cargo: ['....#....', '...#o#...', '..#ooo#..', '.#ooooo#.', '.#xx.xx#.', '.#xx.xx#.', '.#ooooo#.', '.#xx.xx#.', '.#xx.xx#.', '.#ooooo#.',
      '.#xx.xx#.', '.#xx.xx#.', '.#ooooo#.', '.#xx.xx#.', '.#xx.xx#.', '.#ooooo#.', '.#xxxxx#.', '.#xxxxx#.', '.#ooooo#.', '..#####..'],
    tanker: ['....#....', '...#o#...', '..#ooo#..', '.#ooxoo#.', '.#ooxoo#.', '.#ooxoo#.', '.#ooxoo#.', '.#oxxxo#.', '.#ooxoo#.', '.#ooxoo#.',
      '.#ooxoo#.', '.#ooxoo#.', '.#ooxoo#.', '.#ooooo#.', '.#xxxxx#.', '.#xxxxx#.', '.#ooooo#.', '..#####..'],
    tug: ['..###..', '.#ooo#.', '#ooooo#', '#oxxxo#', '#oxxxo#', '#oxxxo#', '#ooooo#', '#oo#oo#', '#ooooo#', '.#ooo#.', '..###..'],
    fishing: ['...#...', '..#o#..', '.#ooo#.', '.#xxx#.', '.#xxx#.', '##ooo##', '#.#o#.#', '..#o#..', '..#o#..', '.#ooo#.', '.#####.'],
    boat: ['...#...', '..#o#..', '.#ooo#.', '.#ooo#.', '.#ooo#.', '.#xxx#.', '.#xxx#.', '.#ooo#.', '.#ooo#.', '.#####.'],
    passenger: ['...#...', '..#o#..', '.#ooo#.', '#xxxxx#', '#xooox#', '#xxxxx#', '#xooox#', '#xxxxx#', '#ooooo#', '#ooooo#', '.#####.'],
    plane: ['.....#.....', '....#o#....', '....#o#....', '...#ooo#...', '.##ooooo##.', '#ooooooooo#', '.####o####.', '....#o#....', '....#o#....', '...##o##...', '...#####...'],
    heli: ['##.......##', '..#.....#..', '...#ooo#...', '....#x#....', '...#oxo#...', '..#ooxoo#..', '...#ooo#...', '..#.###.#..', '.#...#...#.', '#....#....#', '.....#.....', '....###....'],
    bus: ['#####', '#xxx#', '#ooo#', '#o.o#', '#ooo#', '#o.o#', '#ooo#', '#o.o#', '#ooo#', '#ooo#', '#####'],
    alert: ['.....#.....', '....#.#....', '....#.#....', '...#.x.#...', '...#.x.#...', '..#..x..#..', '..#.....#..', '.#...x...#.', '.#.......#.', '###########'],
    alertEmpty: ['.....#.....', '....#.#....', '....#.#....', '...#...#...', '...#...#...', '..#.....#..', '..#.....#..', '.#.......#.', '.#.......#.', '###########']
  };
  window.htPix = (name, color, extra = '') => {
    const rows = G[name] || G.boat;
    const h = rows.length, w = Math.max(...rows.map((r) => r.length)), s = Math.max(w, h);
    let cells = '';
    rows.forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === '.') return;
      const op = ch === 'o' ? ' fill-opacity=".28"' : '';
      if (ch === 'o') cells += `<rect x="${x}" y="${y}" width="1" height="1" fill="#020807" fill-opacity=".8"/>`;
      cells += `<rect x="${x}" y="${y}" width="1" height="1" fill="${color}"${op}/>`;
    }));
    // centered in a square box so a rotated icon never gets cut off
    return `<svg viewBox="${-(s - w) / 2} ${-(s - h) / 2} ${s} ${s}" shape-rendering="crispEdges" aria-hidden="true">${cells}${extra}</svg>`;
  };
})();
