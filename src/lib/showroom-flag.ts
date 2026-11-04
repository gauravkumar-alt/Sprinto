/** Showroom mode flag (kept separate so the request guard doesn't bundle the snapshot data). */
export const isShowroom = () => process.env.SHOWROOM_BUILD === "1" || process.env.SHOWROOM === "true";
