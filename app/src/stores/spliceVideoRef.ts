/**
 * Module-level handle to the splicing preview <video> element so the
 * keyboard layer and timeline controls can drive playback without
 * threading refs through the component tree.
 */
export const spliceVideoRef: { current: HTMLVideoElement | null } = {
  current: null,
};
