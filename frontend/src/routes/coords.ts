/**
 * Coordinates typed or pasted into the place search, in the two forms Google Maps gives you:
 *   40.751167, -74.263250            (right-click a spot, click the numbers)
 *   40°45'04.2"N 74°15'47.7"W         (the "Dropped pin" card)
 * Returns null for anything else, which then goes to the address search.
 */
export function parseCoordinates(text: string): { latitude: number; longitude: number } | null {
  const value = text.trim().replace(/[′’]/g, "'").replace(/[″”]/g, '"');

  const decimal = value.match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (decimal) return valid(Number(decimal[1]), Number(decimal[2]));

  const part = String.raw`(\d{1,3})\s*°\s*(?:(\d{1,2}(?:\.\d+)?)\s*'\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*"\s*)?([NSEW])`;
  const dms = value.match(new RegExp(`^${part}\\s*,?\\s*${part}$`, "i"));
  if (dms) {
    const toDecimal = (deg: string, min = "0", sec = "0", hemi = "") =>
      (Number(deg) + Number(min) / 60 + Number(sec) / 3600) * (/[SW]/i.test(hemi) ? -1 : 1);
    const first = { value: toDecimal(dms[1]!, dms[2], dms[3], dms[4]), latitude: /[NS]/i.test(dms[4]!) };
    const second = { value: toDecimal(dms[5]!, dms[6], dms[7], dms[8]), latitude: /[NS]/i.test(dms[8]!) };
    if (first.latitude === second.latitude) return null;
    return first.latitude ? valid(first.value, second.value) : valid(second.value, first.value);
  }
  return null;
}

function valid(latitude: number, longitude: number) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude: Math.round(latitude * 1e6) / 1e6, longitude: Math.round(longitude * 1e6) / 1e6 };
}
