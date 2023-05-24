# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
