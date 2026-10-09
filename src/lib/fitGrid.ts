// src/lib/fitGrid.ts
//
// Lay N tiles out to fill a box: the column count whose tiles come out
// largest while every row still fits, keeping each tile's aspect. Used by
// the camera board's display mode, which shows only the cameras that are
// live and sizes them to the screen — one live camera fills it, fifty
// share it. Past PER_PAGE tiles a board pages instead: fit-to-screen
// stops being readable beyond that.

export const PER_PAGE = 50;

export interface GridFit {
  cols: number;
  rows: number;
  /** Tile width and height in px (whole pixels, gaps already taken out). */
  tileW: number;
  tileH: number;
}

export function fitGrid(n: number, width: number, height: number, aspect = 4 / 3, gap = 3): GridFit {
  if (n <= 0 || width <= 0 || height <= 0) return { cols: 1, rows: 0, tileW: 0, tileH: 0 };
  let best: GridFit = { cols: 1, rows: n, tileW: 0, tileH: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const byWidth = (width - gap * (cols - 1)) / cols;
    const byHeight = ((height - gap * (rows - 1)) / rows) * aspect;
    const w = Math.floor(Math.min(byWidth, byHeight));
    if (w > best.tileW) best = { cols, rows, tileW: w, tileH: Math.floor(w / aspect) };
  }
  return best;
}

export interface GridFill {
  cols: number;
  rows: number;
  /** Cell size in px that, with the gaps, covers the whole box. */
  cellW: number;
  cellH: number;
}

/**
 * The same columns and rows as fitGrid, but the cells stretched to cover
 * the box edge to edge — no empty bands around the grid. The video in
 * each cell fills it (object-cover); an incomplete last row is centred.
 */
export function fillGrid(n: number, width: number, height: number, gap = 3): GridFill {
  const f = fitGrid(n, width, height, 4 / 3, gap);
  if (!f.rows) return { cols: 1, rows: 0, cellW: 0, cellH: 0 };
  return {
    cols: f.cols,
    rows: f.rows,
    cellW: Math.floor((width - gap * (f.cols - 1)) / f.cols),
    cellH: Math.floor((height - gap * (f.rows - 1)) / f.rows),
  };
}

/** Page `page` (0-based, clamped) of `items`, PER_PAGE at a time. */
export function pageOf<T>(items: T[], page: number, per = PER_PAGE): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / per));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { items: items.slice(p * per, p * per + per), page: p, pages };
}
