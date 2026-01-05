# Handsy - Nail ID Capture UI

A Next.js web application for capturing multi-photo hand images to create a Nail ID.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Run the development server:
```bash
npm run dev
```

3. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Project Structure

- `app/` - Next.js app directory
  - `page.tsx` - Main page with flow state management
  - `layout.tsx` - Root layout
  - `globals.css` - Global styles
- `components/` - React components
  - `CaptureEntry.tsx` - Welcome/landing screen
  - `CaptureRules.tsx` - Before you start rules
  - `CameraRules.tsx` - Camera setup instructions
  - `PhotoCapture.tsx` - Photo capture screen (all 4 photos)
  - `PhotoPreview.tsx` - Photo preview with retake option
  - `CaptureConfirm.tsx` - Final confirmation before submit
  - `SuccessScreen.tsx` - Success state
  - `ErrorScreen.tsx` - Error state
  - `ProgressIndicator.tsx` - Progress indicator (Photo X of 4)

## Flow

1. **capture_entry** - Welcome screen
2. **capture_rules** - Before you start rules
3. **camera_rules** - Camera setup instructions
4. **photo_1_top_down** - First photo (top-down view)
5. **photo_preview** - Preview first photo
6. **photo_2_forward_lean** - Second photo (slight angle)
7. **photo_preview** - Preview second photo
8. **photo_3_thumb_top_down** - Third photo (thumb top-down)
9. **photo_preview** - Preview third photo
10. **photo_4_thumb_oblique** - Fourth photo (thumb angle)
11. **photo_preview** - Preview fourth photo
12. **capture_confirm** - Final confirmation
13. **success/error** - Result screen

## Features Implemented (Week 1)

- ✅ Complete UI flow skeleton
- ✅ All screens from the flow document
- ✅ Photo capture with file input
- ✅ Photo preview with retake option
- ✅ Progress indicator (Photo X of 4)
- ✅ Client-side validation (file type, file size)
- ✅ Photo order enforcement
- ✅ Image count enforcement (4 photos required)
- ✅ Success/Error placeholder screens

## Next Steps (Week 2)

- API integration with `/upload` endpoint
- Upload progress states
- Backend error handling
- Retry logic
- Logging

## Tech Stack

- Next.js 14 (App Router)
- React 18
- TypeScript
- Tailwind CSS

