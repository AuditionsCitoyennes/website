// The dialogs open at this moment, bottom to top. One can open over another
// (an audition's popup, then the form that edits it): only the top one answers
// Escape, each sits above the one it was opened from, and the page stays
// locked until the last one closes. ModalDialog enrols one Symbol per instance.
export const openDialogs: symbol[] = [];
