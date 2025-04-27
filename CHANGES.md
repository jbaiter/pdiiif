# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.6] - 2025-04-27

### Added
- Add support for optimizing JPEG images to reduce the size of generated PDFs by
  up to 50%.
- Generating PDFs from IIIF Manifests with PNG images now works

## [0.2.5] - 2024-07-10

### Fixed
- pdiiif-lib: Parse lowercase hex strings when parsing PDFs, fixes coverpage
  integration from react-pdf sourced PDFs. Many thanks to @fstoe from UB Leipzig
  for discovering and fixing the bug.

## [0.2.4] - 2024-02-26

### Changed
- Updated minimum Node.js version to 20 due to stabilization of built-in `fetch`

## [0.2.3] - 2023-10-06

### Fixed
- pdiiif-lib: Fix regression in OCR handling, detect OCR in `rendering` field

## [0.2.2] - 2023-10-06

### Fixed
- pdiiif-lib: Made coverpage metadata extraction more robust

## [0.2.1] - 2023-09-30

### Fixed
- pdiiif-lib: Fix broken ALTO XML parsing

## [0.2.0] - 2023-09-26

### Changed
- pdiiif-lib: A DOM implementation is no longer required, wich makes it possible
  to use pdiiif from a Worker or Service Worker

### Fixed
- pdiiif-lib: Fixed broken CommonJS build

## [0.1.9] - 2023-07-06

### Changed
- pdiiif-lib: `convertManifest` now returns a `ConversionReport` with details
  about the PDF generation process, including which images and OCR files failed
  to download
- pdiiif-lib: Be more obnoxious when retrying failed resource downloads, namely
  retry on 4xx errors as well as 5xx

### Added
- pdiiif-lib: Added a `onNotification(notification: ProgressNotification)` API
  through which errors/warnings that don't abort the PDF generation can be
  displayed while the PDF is generating
- pdiiif-api: Added a `notification` event type to inform users about errors/
  warnings that don't abort the PDF generation
- pdiiif-web: Show notifications for errors/warnings during PDF generation

### Fixed
- pdiiif-lib: Fix compatibility with Node.js versions >=20
- pdiiif-lib: Fix broken PDFs when images fail to download
- pdiiif-web: Fix premature download termination in Firefox >=102 when
  the PDF generation process is very slow


## [0.1.8] - 2023-06-27

### Fixed
- pdiiif-api: Fix bug when running in Node 20
- pdiiif-lib: Fix version specifier

## [0.1.7] - 2023-06-22

### Changed
- docker: Updated image to Node 20 and Debian bookworm, rely on Puppeteer-provided
  Chrome version instead of downloading it from the Debian repository

### Fixed
- pdiiif-lib: fetch polyfill for older Node.js versions works now
- pdiiif-api: Exceptions are now properly logged

## [0.1.6] - 2023-06-20

### Changed
- pdiiif-lib: `estimatePdfSize` now returns a `{ size: number; corsEnabled: boolean }`
  object instead of simply a `number`. This allows you to check if the Image API
  endpoints that were sampled to determine the size have CORS available
- pdiiif-web: The `KeepAliveStreamSaver` class no longer relies on the `navigator.locks`
  API, increasing compatibility with older browsers

### Added
- pdiiif-lib: Content-Negotation for IIIF Presentation API 3 manifests is now implemented

### Fixed
- pdiiif-web: Detection for unavailability of CORS is now working properly and falling
  back to server-side PDF generation
- pdiiif-lib: Choice parsing could fail under some circumstances, this has been fixed
- pdiiif-api: PDF filenames would sometimes fail to generate properly, resulting in
  a `.pdf` filename, this has been fixed

## [0.1.5] - 2023-06-08

### Fixed
- pdiiif-lib: Fix coverpage parsing on browsers that don't support
  `TypedArray#findLastIndex` by implementing a polyfill for it
  (#24, thanks @andybuki for reporting)


## [0.1.4] - 2023-06-07

No changes for this release, limited to `pdiiif-server` npm package due
to a messed up npm deploymennt.


## [0.1.3] - 2023-06-07

### Added
- [New section](./README.md#cover-page-endpoints) in README on how to implement
  custom cover pages by using a self-hosted or custom server instance.

### Fixed
- pdiiif-lib: Fix broken license logo URLs for CC-NC-ND and CC0
- pdiiif-lib: Add missing Public Domain Mark 1.0 license logo
- pdiiif-lib: Fix infinite loop with certain manifests when estimating PDF
  size (#23, thanks @ch-sander for reporting)
- pdiiif-api: Remove pdiiif-web dependency, vendor in bundles and HTML
  to fix shipping via npm

### Changed
- pdiiif-api: Add support for more handlebars helpers in templates by
  adding [`handlebars-helpers](https://github.com/helpers/handlebars-helpers)
- Dependency updates for all packages
- Removed mkcert integration

## [0.1.2] - 2023-05-25

### Fixed
- pdiiif-lib: Fix broken offset sorting when transplanting cover page PDFs that
  would lead to broken PDFs in some instances

## [0.1.1] - 2023-05-24

### Fixed
- pdiiif-lib: Selecting a custom range of canvases now also works when the
  Manifest has ranges defined, this would result in an error previously
  ([#20][issue-20])
- pdiiif-lib: Prevent inclusion of duplicate Table of Contents tree when converting
  from IIIFv2 manifests with a `top` range ([#21][issue-21])
- pdiiif-lib: PDFs from manifests that reference OCR that fails to fetch during
  converting now no longer result in a broken state ([#17][issue-17])

### Changed
- Removed `lodash` dependency in favor of EcmaScript builtins and to reduce bundle
  size
- pdiiif-web: SSL via `mkcert` is now fully optional for running the
  development server
