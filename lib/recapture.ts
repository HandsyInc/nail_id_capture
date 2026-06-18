export const RECAPTURE_HANDS = ['LEFT', 'RIGHT'] as const

export const RECAPTURE_FINGERS = [
  'THUMB',
  'INDEX',
  'MIDDLE',
  'RING',
  'PINKY',
] as const

export const RECAPTURE_VIEWS = ['TOP', 'FRONT', 'SIDE'] as const

export const RECAPTURE_REASON_LABELS = {
  PHOTO_ISSUE: 'Photo Issue',
  MEASUREMENT_CONFIRMATION: 'Measurement Confirmation',
  OTHER: 'Other',
} as const

export const RECAPTURE_HAND_LABELS = {
  LEFT: 'Left Hand',
  RIGHT: 'Right Hand',
} as const

export const RECAPTURE_FINGER_LABELS = {
  THUMB: 'Thumb',
  INDEX: 'Index',
  MIDDLE: 'Middle',
  RING: 'Ring',
  PINKY: 'Pinky',
} as const

export const RECAPTURE_VIEW_LABELS = {
  TOP: 'Top View',
  FRONT: 'Front View',
  SIDE: 'Side View',
} as const

export type RecaptureHand = typeof RECAPTURE_HANDS[number]
export type RecaptureFinger = typeof RECAPTURE_FINGERS[number]
export type RecaptureView = typeof RECAPTURE_VIEWS[number]

export type RecaptureTarget = {
  hand: RecaptureHand
  finger: RecaptureFinger
  views: RecaptureView[]
}