/** A GPS point in decimal degrees. */
export interface ShopLocation {
  latitude: number;
  longitude: number;
}

export type LocationFailure = 'unsupported' | 'denied' | 'unavailable' | 'timeout';

/** Rounds a GPS reading to six decimal places, or rejects a reading outside the valid range. */
export function parseCoordinates(latitude: number, longitude: number): ShopLocation | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return {
    latitude: Math.round(latitude * 1e6) / 1e6,
    longitude: Math.round(longitude * 1e6) / 1e6,
  };
}

export function locationFailure(error: unknown): LocationFailure {
  if (error instanceof Error && error.message === 'unsupported') return 'unsupported';
  const code = (error as { code?: number } | null)?.code;
  if (code === 1) return 'denied';
  if (code === 3) return 'timeout';
  return 'unavailable';
}

/** Reads the phone's GPS position. Rejects when the browser or the person refuses. */
export function readDeviceLocation(): Promise<ShopLocation> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('unsupported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const parsed = parseCoordinates(position.coords.latitude, position.coords.longitude);
        if (!parsed) reject(new Error('unavailable'));
        else resolve(parsed);
      },
      (error) => reject(error),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 }
    );
  });
}
