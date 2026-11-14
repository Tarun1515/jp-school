/*==============================================================================
  COORDINATES — ONE RULE, ONE WORDING, THREE FORMS (SR-6)

  The campus dialog, the registration address step and (read-only) the school
  profile all deal in the same pair of numbers. SR-6 made them visible and
  editable, which means for the first time there is a RULE about what may go in
  them — and a rule written three times is three rules the first time one is
  corrected.

  ------------------------------------------------------------------------------
  🔴 THE DIFFERENCE BETWEEN A NUMBER SOMEBODY TYPED AND A NUMBER WE PRODUCED
  ------------------------------------------------------------------------------
  This is the whole reason this file has both a validator and a rounder, and
  getting it backwards breaks a form in a way that is very hard to see:

    A TYPED NUMBER IS VALIDATED. Nine decimal places pasted out of a mapping
      tool, or a longitude in the latitude box, is a mistake worth naming —
      silently "fixing" what somebody typed hides the mistake instead.

    A NUMBER WE PRODUCED IS ROUNDED, NEVER REFUSED. Leaflet hands back a click
      as 28.45949658203125 and the address provider answers with seven decimal
      places; both are perfectly correct and neither is the user's doing.
      Validating those would mean a school drops a pin on the map, or looks up
      its own address, and is told its coordinates are invalid — by a rule it
      has no way to satisfy and did not trigger.

  So every programmatic write goes through `roundCoordinate`, and the validator
  only ever judges what a person typed.

  ------------------------------------------------------------------------------
  ⚠️ AND NONE OF IT IS REQUIRED
  ------------------------------------------------------------------------------
  A pin is optional on every one of the three screens. An empty value is VALID
  here — a school that never opens the map still registers and still saves. The
  only cross-field rule is that half a pin is not a place (see
  `coordinatePairProblem`).
==============================================================================*/

/**
 * Six decimal places.
 *
 * About ten centimetres at the equator, which is finer than any school needs
 * and is the precision the two columns hold.
 */
export const COORDINATE_DECIMALS = 6;

/** Latitude runs −90..90, longitude −180..180. */
export const COORDINATE_BOUNDS = {
  latitude: 90,
  longitude: 180,
} as const;

export type CoordinateAxis = keyof typeof COORDINATE_BOUNDS;

/** What is wrong with a coordinate, or null when nothing is. */
export type CoordinateProblem = 'not-a-number' | 'range' | 'precision';

/**
 * Rounds a coordinate to what we store.
 *
 * 🔴 USE THIS ON EVERY COORDINATE THE PRODUCT ITSELF PRODUCES — a pin from the
 * map, a point from the address provider. Leaflet reports a click to full double
 * precision and Places answers with seven decimal places, and both would fail
 * `coordinateProblem`'s precision test. Rounding is right for those and wrong
 * for a typed value; the long argument is at the top of this file.
 *
 * ⚠️ Null passes through as null. There is no "0 as a default" here: zero is a
 * real latitude and a real longitude, and the difference between "no pin" and
 * "a pin in the Gulf of Guinea" must survive this function.
 */
export function roundCoordinate(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;

  const scale = 10 ** COORDINATE_DECIMALS;

  return Math.round(value * scale) / scale;
}

/**
 * Whether one typed coordinate is usable, and what is wrong with it.
 *
 * ⚠️ AN EMPTY VALUE IS NOT A PROBLEM. Null, undefined and the empty string an
 * emptied `<input type="number">` leaves behind all return null: the field is
 * optional, and that is not negotiable on any of the three screens.
 *
 * ⚠️ THE PRECISION TEST IS DONE ON THE SCALED NUMBER, NOT ON THE TEXT. Counting
 * digits after the '.' in `String(value)` breaks on exponent notation — `1e-7`
 * has no '.' at all and would pass — and a number input will hand over exactly
 * that for a small enough paste. A seventh decimal digit leaves a fractional
 * part of at least 0.1 after scaling by a million, while double precision at
 * these magnitudes is accurate to about 1e-8, so the 1e-3 tolerance separates
 * the two cases with four orders of magnitude to spare.
 */
export function coordinateProblem(
  value: number | string | null | undefined,
  axis: CoordinateAxis,
): CoordinateProblem | null {
  if (value === null || value === undefined || value === '') return null;

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) return 'not-a-number';

  const bound = COORDINATE_BOUNDS[axis];

  if (parsed < -bound || parsed > bound) return 'range';

  const scaled = parsed * 10 ** COORDINATE_DECIMALS;

  return Math.abs(scaled - Math.round(scaled)) > 1e-3 ? 'precision' : null;
}

/**
 * What to say about it.
 *
 * ⚠️ THE RANGE MESSAGE NAMES THE SWAP, because that is what has almost always
 * happened: in India a longitude is 68–97 and a latitude is 8–37, so a
 * longitude typed into the latitude box is the one mistake this check catches
 * most. Naming the likely cause turns a complaint into an instruction.
 */
export function coordinateMessage(axis: CoordinateAxis, problem: CoordinateProblem): string {
  const bound = COORDINATE_BOUNDS[axis];

  switch (problem) {
    case 'not-a-number':
      return 'That is not a number we can put on a map.';

    case 'range':
      return `A ${axis} is between −${bound} and ${bound}. Check you have not swapped the two boxes.`;

    case 'precision':
      return 'Six decimal places is as precise as this gets — about ten centimetres. Trim the extra digits.';
  }
}

/**
 * Both, or neither.
 *
 * 🔴 HALF A PIN IS NOT A PLACE. The two columns are independent, so a latitude
 * with no longitude saves happily and puts the school on the Greenwich meridian
 * — in the Atlantic, for anything in India. The map always emits the pair, so
 * this can only ever fire on hand entry, which is exactly where it is needed.
 *
 * Returns the axis that is MISSING, or null when the pair is consistent.
 */
export function coordinatePairProblem(
  latitude: number | string | null | undefined,
  longitude: number | string | null | undefined,
): CoordinateAxis | null {
  const hasLatitude = isPresent(latitude);
  const hasLongitude = isPresent(longitude);

  if (hasLatitude === hasLongitude) return null;

  return hasLatitude ? 'longitude' : 'latitude';
}

/** The sentence for a half-entered pin. */
export function coordinatePairMessage(missing: CoordinateAxis): string {
  const other: CoordinateAxis = missing === 'latitude' ? 'longitude' : 'latitude';

  return `A point needs both numbers. Add the ${missing} too, or clear the ${other}.`;
}

function isPresent(value: number | string | null | undefined): boolean {
  return value !== null && value !== undefined && value !== '';
}
