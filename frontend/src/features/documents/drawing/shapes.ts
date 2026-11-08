type ShapeCategory = 'Shapes' | 'Arrows' | 'Flowchart' | 'Callouts' | 'Equation';
type ShapeDefinition = { id: string; name: string; category: ShapeCategory; path: string };
const polygon = (points: number[][]) => points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ') + 'Z';
const regular = (sides: number, inner = 1) => polygon(Array.from({ length: inner === 1 ? sides : sides * 2 }, (_, i) => {
  const angle = -Math.PI / 2 + i * Math.PI * 2 / (inner === 1 ? sides : sides * 2), r = i % 2 && inner !== 1 ? 48 * inner : 48;
  return [50 + Math.cos(angle) * r, 50 + Math.sin(angle) * r];
}));
const rotate = (path: string, degrees: number) => {
  // All arrow variants below are polygons, so transform their coordinate pairs.
  const rad = degrees * Math.PI / 180;
  return path.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_, x, y) => `${(50 + (Number(x) - 50) * Math.cos(rad) - (Number(y) - 50) * Math.sin(rad)).toFixed(2)} ${(50 + (Number(x) - 50) * Math.sin(rad) + (Number(y) - 50) * Math.cos(rad)).toFixed(2)}`);
};
const rightArrow = 'M0 30 L60 30 L60 0 L100 50 L60 100 L60 70 L0 70 Z';
const rightLeft = 'M0 50 L30 0 L30 30 L70 30 L70 0 L100 50 L70 100 L70 70 L30 70 L30 100 Z';
const definitions: [ShapeCategory, [string, string, string][]][] = [
  ['Shapes', [
    ['rectangle', 'Rectangle', 'M0 0H100V100H0Z'],
    ['rounded-rectangle', 'Rounded rectangle', 'M16 0H84Q100 0 100 16V84Q100 100 84 100H16Q0 100 0 84V16Q0 0 16 0Z'],
    ['ellipse', 'Ellipse', 'M100 50A50 50 0 1 1 0 50A50 50 0 1 1 100 50Z'],
    ['triangle', 'Triangle', 'M50 0L100 100H0Z'],
    ['right-triangle', 'Right triangle', 'M0 0L100 100H0Z'],
    ['diamond', 'Diamond', 'M50 0L100 50L50 100L0 50Z'],
    ['parallelogram', 'Parallelogram', 'M25 0H100L75 100H0Z'],
    ['trapezoid', 'Trapezoid', 'M25 0H75L100 100H0Z'],
    ['pentagon', 'Pentagon', regular(5)], ['hexagon', 'Hexagon', regular(6)],
    ['heptagon', 'Heptagon', regular(7)], ['octagon', 'Octagon', regular(8)],
    ['decagon', 'Decagon', regular(10)], ['dodecagon', 'Dodecagon', regular(12)],
    ['star-4', 'Four-point star', regular(4, .28)], ['star-5', 'Five-point star', regular(5, .42)],
    ['star-6', 'Six-point star', regular(6, .5)], ['star-8', 'Eight-point star', regular(8, .5)],
    ['star-12', 'Twelve-point star', regular(12, .7)], ['star-16', 'Sixteen-point star', regular(16, .75)],
    ['heart', 'Heart', 'M50 25C20 -20 -20 20 10 55L50 100L90 55C120 20 80 -20 50 25Z'],
    ['lightning', 'Lightning bolt', 'M50 0L10 55H43L30 100L90 35H55L75 0Z'],
    ['moon', 'Crescent', 'M75 2A50 50 0 1 0 75 98C20 90 20 10 75 2Z'],
    ['sun', 'Sun', regular(12, .55) + 'M75 50A25 25 0 1 1 25 50A25 25 0 1 1 75 50Z'],
    ['cloud', 'Cloud', 'M20 80C-5 80 -5 45 12 40C5 15 35 0 50 18C70 -5 95 12 88 35C110 40 105 75 85 78C78 98 50 100 40 85C30 98 18 95 20 80Z'],
    ['ring', 'Donut', 'M100 50A50 50 0 1 1 0 50A50 50 0 1 1 100 50ZM75 50A25 25 0 1 0 25 50A25 25 0 1 0 75 50Z'],
    ['arc', 'Arc', 'M0 100A100 100 0 0 1 100 0L100 25A75 75 0 0 0 25 100Z'],
    ['pie', 'Pie', 'M50 50V0A50 50 0 1 1 0 50Z'],
    ['teardrop', 'Teardrop', 'M100 0V50A50 50 0 1 1 50 0Z'],
    ['cube', 'Cube', 'M0 25L30 0H100V75L70 100H0ZM0 25H70V100M70 25L100 0'],
    ['cylinder', 'Cylinder', 'M0 15C0 -5 100 -5 100 15V85C100 105 0 105 0 85ZM0 15C0 35 100 35 100 15'],
    ['cross', 'Cross', 'M35 0H65V35H100V65H65V100H35V65H0V35H35Z'],
    ['folded-corner', 'Folded corner', 'M0 0H75L100 25V100H0ZM75 0V25H100'],
    ['frame', 'Frame', 'M0 0H100V100H0ZM18 18V82H82V18Z'],
    ['plaque', 'Plaque', 'M20 0H80Q80 20 100 20V80Q80 80 80 100H20Q20 80 0 80V20Q20 20 20 0Z'],
    ['bevel', 'Bevel', 'M0 0H100V100H0ZM15 15H85V85H15ZM0 0L15 15M100 0L85 15M100 100L85 85M0 100L15 85'],
    ['smiley', 'Smiley face', 'M100 50A50 50 0 1 1 0 50A50 50 0 1 1 100 50ZM27 35A4 4 0 1 1 35 35A4 4 0 1 1 27 35ZM65 35A4 4 0 1 1 73 35A4 4 0 1 1 65 35ZM25 62Q50 95 75 62'],
    ['bracket-left', 'Left bracket', 'M70 0H25V100H70V88H40V12H70Z'],
    ['bracket-right', 'Right bracket', 'M30 0H75V100H30V88H60V12H30Z'],
    ['brace-left', 'Left brace', 'M80 0Q35 0 35 25V35Q35 45 10 50Q35 55 35 65V75Q35 100 80 100V88Q50 88 50 72V62Q50 55 35 50Q50 45 50 38V28Q50 12 80 12Z'],
  ]],
  ['Arrows', [
    ['arrow-right', 'Right arrow', rightArrow], ['arrow-left', 'Left arrow', rotate(rightArrow, 180)],
    ['arrow-up', 'Up arrow', rotate(rightArrow, -90)], ['arrow-down', 'Down arrow', rotate(rightArrow, 90)],
    ['arrow-left-right', 'Left-right arrow', rightLeft], ['arrow-up-down', 'Up-down arrow', rotate(rightLeft, 90)],
    ['arrow-quad', 'Four-way arrow', 'M50 0L70 25H60V40H75V30L100 50L75 70V60H60V75H70L50 100L30 75H40V60H25V70L0 50L25 30V40H40V25H30Z'],
    ['arrow-chevron', 'Chevron', 'M0 0H60L100 50L60 100H0L40 50Z'],
    ['arrow-notched', 'Notched arrow', 'M0 25H60V0L100 50L60 100V75H0L20 50Z'],
    ['arrow-pentagon', 'Pentagon arrow', 'M0 0H60L100 50L60 100H0Z'],
    ['arrow-bent', 'Bent arrow', 'M0 100V30Q0 15 15 15H60V0L100 30L60 60V45H30V100Z'],
    ['arrow-u-turn', 'U-turn arrow', 'M0 100V35C0 -12 75 -12 75 35V55H100L60 100L30 55H50V35C50 15 25 15 25 35V100Z'],
    ['arrow-circular', 'Circular arrow', 'M85 20L100 0V50H50L68 33A25 25 0 1 0 75 60H100A50 50 0 1 1 85 20Z'],
    ['arrow-split', 'Split arrow', 'M40 100V60L15 35L0 50V0H50L35 15L50 30L65 15L50 0H100V50L85 35L60 60V100Z'],
    ['arrow-striped', 'Striped arrow', 'M0 30H6V70H0ZM12 30H20V70H12ZM28 30H60V0L100 50L60 100V70H28Z'],
  ]],
  ['Flowchart', [
    ['flow-process', 'Process', 'M0 0H100V100H0Z'],
    ['flow-alternate', 'Alternate process', 'M15 0H85Q100 0 100 15V85Q100 100 85 100H15Q0 100 0 85V15Q0 0 15 0Z'],
    ['flow-decision', 'Decision', 'M50 0L100 50L50 100L0 50Z'],
    ['flow-data', 'Data / input-output', 'M25 0H100L75 100H0Z'],
    ['flow-predefined', 'Predefined process', 'M0 0H100V100H0ZM15 0V100M85 0V100'],
    ['flow-internal', 'Internal storage', 'M0 0H100V100H0ZM15 0V100M0 18H100'],
    ['flow-document', 'Document', 'M0 0H100V80C60 55 40 105 0 85Z'],
    ['flow-multidocument', 'Multiple documents', 'M16 0H100V72L92 68V8H8V16H84V84C44 59 30 109 0 90V16M84 84L92 80V8'],
    ['flow-terminator', 'Terminator', 'M25 0H75C108 0 108 100 75 100H25C-8 100 -8 0 25 0Z'],
    ['flow-preparation', 'Preparation', 'M20 0H80L100 50L80 100H20L0 50Z'],
    ['flow-manual-input', 'Manual input', 'M0 25L100 0V100H0Z'],
    ['flow-manual-operation', 'Manual operation', 'M0 0H100L75 100H25Z'],
    ['flow-connector', 'Connector', 'M100 50A50 50 0 1 1 0 50A50 50 0 1 1 100 50Z'],
    ['flow-offpage', 'Off-page connector', 'M0 0H100V60L50 100L0 60Z'],
    ['flow-delay', 'Delay', 'M0 0H50C116 0 116 100 50 100H0Z'],
    ['flow-database', 'Database', 'M0 15C0 -5 100 -5 100 15V85C100 105 0 105 0 85ZM0 15C0 35 100 35 100 15'],
    ['flow-display', 'Display', 'M20 0H75C108 0 108 100 75 100H20L0 50Z'],
    ['flow-sort', 'Sort', 'M50 0L100 50L50 100L0 50ZM0 50H100'],
    ['flow-merge', 'Merge', 'M0 0H100L50 100Z'],
    ['flow-extract', 'Extract', 'M50 0L100 100H0Z'],
    ['flow-stored', 'Stored data', 'M20 0H100C70 20 70 80 100 100H20C-5 80 -5 20 20 0Z'],
    ['flow-tape', 'Paper tape', 'M0 15C35 40 65 -10 100 15V85C65 60 35 110 0 85Z'],
  ]],
  ['Callouts', [
    ['callout-rectangle', 'Rectangular callout', 'M0 0H100V75H50L20 100L25 75H0Z'],
    ['callout-rounded', 'Rounded callout', 'M15 0H85Q100 0 100 15V60Q100 75 85 75H50L20 100L25 75H15Q0 75 0 60V15Q0 0 15 0Z'],
    ['callout-oval', 'Oval callout', 'M28 70C-15 60 -10 0 50 0C115 0 115 80 55 78L20 100Z'],
    ['callout-cloud', 'Cloud callout', 'M20 60C-5 60 -5 30 12 25C10 0 40 -5 50 12C75 -5 98 10 88 30C110 45 90 72 75 60C60 85 30 75 20 60ZM25 78A6 6 0 1 0 13 78A6 6 0 1 0 25 78ZM10 94A4 4 0 1 0 2 94A4 4 0 1 0 10 94Z'],
    ['callout-burst', 'Explosion callout', regular(12, .65)],
    ['callout-ribbon', 'Ribbon', 'M15 15H85V70H15ZM15 30H0L10 55L0 85H30V70M85 30H100L90 55L100 85H70V70M15 70L30 85M85 70L70 85'],
  ]],
  ['Equation', [
    ['math-plus', 'Plus', 'M35 0H65V35H100V65H65V100H35V65H0V35H35Z'],
    ['math-minus', 'Minus', 'M0 35H100V65H0Z'],
    ['math-multiply', 'Multiply', 'M15 0L50 35L85 0L100 15L65 50L100 85L85 100L50 65L15 100L0 85L35 50L0 15Z'],
    ['math-divide', 'Divide', 'M0 40H100V60H0ZM60 12A10 10 0 1 1 40 12A10 10 0 1 1 60 12ZM60 88A10 10 0 1 1 40 88A10 10 0 1 1 60 88Z'],
    ['math-equals', 'Equals', 'M0 20H100V40H0ZM0 60H100V80H0Z'],
    ['math-not-equal', 'Not equal', 'M0 20H100V40H0ZM0 60H100V80H0ZM65 0H85L35 100H15Z'],
  ]],
];
export const drawingShapes: ShapeDefinition[] = definitions.flatMap(([category, shapes]) => shapes.map(([id, name, path]) => ({ id, name, category, path })));
export const shapeById = new Map(drawingShapes.map(shape => [shape.id, shape]));
export const shapeCategories = definitions.map(([category]) => category);
export const shapeIcon = (id: string) => `<svg viewBox="-5 -5 110 110" aria-hidden="true"><path d="${shapeById.get(id)?.path || 'M0 0H100V100H0Z'}" fill="currentColor" fill-opacity=".12" stroke="currentColor" stroke-width="5" stroke-linejoin="round" fill-rule="nonzero"/></svg>`;
