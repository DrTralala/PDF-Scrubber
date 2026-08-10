import { expect, it } from 'vitest';

import { deriveRichFitRegion } from './rich-fit-region';

it('keeps horizontal width while padding for font-height differences', () => {
  const region = deriveRichFitRegion(
    { x: 72, y: 700, width: 158, height: 24 },
    [{ x: 72, y: 700, width: 12, height: 24 }],
    [1, 0],
  );

  expect(region).toEqual({ x: 72, y: 676, width: 158, height: 72 });
});

it('pads the horizontal axis for vertically rotated text', () => {
  const region = deriveRichFitRegion(
    { x: -217.2, y: 172, width: 22.2, height: 156 },
    [{ x: -217.2, y: 172, width: 22.2, height: 12 }],
    [0, 1],
  );

  expect(region.x).toBeCloseTo(-239.4, 6);
  expect(region.y).toBe(172);
  expect(region.width).toBeCloseTo(66.6, 6);
  expect(region.height).toBe(156);
});

it('pads both canonical axes for sheared text', () => {
  const region = deriveRichFitRegion(
    { x: 72, y: 709.4, width: 156, height: 53.4 },
    [{ x: 72, y: 709.4, width: 14, height: 25 }],
    [0.9805806757, 0.1961161351],
  );

  expect(region.x).toBeLessThan(72);
  expect(region.y).toBeLessThan(709.4);
  expect(region.width).toBeGreaterThan(156);
  expect(region.height).toBeGreaterThan(53.4);
});
