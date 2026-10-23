export interface ScrollFollowState {
  following: boolean;
  previousOffset: number;
  previousContentHeight: number;
}

export interface ScrollSample {
  offset: number;
  contentHeight: number;
  viewportHeight: number;
}

export interface ScrollFollowResult {
  following: boolean;
  offset: number;
  contentHeight: number;
  jumpVisible: boolean;
  programmaticHandled: boolean;
}

/** Bottom offset from real ScrollView content/viewport heights, not cell estimates. */
export function bottomOffset(contentHeight: number, viewportHeight: number): number {
  return Math.max(0, contentHeight - viewportHeight);
}

/** Pure follow-state transition used by the panel's onScroll handler. */
export function nextScrollFollow(input: {
  state: ScrollFollowState;
  sample: ScrollSample;
  programmaticTarget: number | null;
}): ScrollFollowResult {
  const { state, sample, programmaticTarget } = input;
  const { offset, contentHeight, viewportHeight } = sample;
  let following = state.following;
  let programmaticHandled = false;
  const contentShrank = contentHeight < state.previousContentHeight - 2;
  const movedUp = offset < state.previousOffset - 1;
  const clampedOffset = Math.min(
    state.previousOffset,
    bottomOffset(contentHeight, viewportHeight),
  );

  // A programmatic event is trustworthy only when it does not move upward, or
  // when an upward move matches the browser's layout clamp after a shrink.
  const programmaticMatch =
    programmaticTarget !== null &&
    Math.abs(offset - programmaticTarget) <= 2 &&
    (!movedUp || (contentShrank && offset >= clampedOffset - 1));

  if (programmaticMatch) {
    programmaticHandled = true;
  } else if (movedUp) {
    // Movement beyond the theoretical clamp is a real user up-scroll, even if
    // content happened to shrink at the same time.
    if (!contentShrank || offset < clampedOffset - 1) following = false;
  } else if (
    offset > state.previousOffset + 1 &&
    offset + viewportHeight >= contentHeight - 40
  ) {
    // Scrolling back into the bottom zone re-attaches follow.
    following = true;
  }

  return {
    following,
    offset,
    contentHeight,
    jumpVisible: !following,
    programmaticHandled,
  };
}
