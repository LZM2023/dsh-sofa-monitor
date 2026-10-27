// Interface-only updates can keep using a compatible, already-running backend.
// The minimum is explicit in the package; never assume a numeric mismatch is safe.
export function backendIsCompatible(actual,minimum,release){
  if([actual,minimum,release].some(value=>typeof value!=='string'||!/^\d+\.\d+\.\d+$/u.test(value)))return false;
  const current=actual.split('.').map(Number),required=minimum.split('.').map(Number),latest=release.split('.').map(Number);
  if(current[0]!==required[0]||current[1]!==required[1]||current[0]!==latest[0]||current[1]!==latest[1])return false;
  return current[2]>=required[2]&&current[2]<=latest[2];
}
