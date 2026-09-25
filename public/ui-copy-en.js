// Public demo copy. No product catalogue or private test names.
const text = value => typeof value === 'string' ? value : '';
export const uiRegionCount = count => `${count} region${count === 1 ? '' : 's'}`;
export function uiSurfaceLabel(value) { const name = text(typeof value === 'string' ? value : value?.label); return ({'地面':'Floor','墙面':'Wall','防溅墙':'Splashback'})[name] || name || 'Region'; }
export const uiTileName = value => text(typeof value === 'string' ? value : value?.name);
export const uiRoomName = uiTileName;
export const uiCaseName = uiTileName;
export const uiDisplayText = text;
export const uiCaseNotes = value => text(value?.notes);
export const uiErrorMessage = (value, fallback='Could not complete this action.') => text(value) || fallback;
