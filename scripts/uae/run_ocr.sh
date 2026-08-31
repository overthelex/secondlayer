#!/bin/bash
# OCR the legislation PDFs on prod, deliberately throttled: tesseract is
# multi-threaded by default and 8 workers x 8 threads on an 8-core box drove the
# load average to 32 and the throughput to 1/10th. One thread per worker, five
# workers, lowest priority - the app keeps three cores and I/O priority.
cd "$HOME/uae"
export TESSDATA_PREFIX=$HOME/uae/tessdata
export OMP_THREAD_LIMIT=1
mkdir -p legocr
echo "$(date -u +%FT%TZ) OCR start: $(ls legocr | wc -l)/$(ls legpdf | wc -l)" >> ocr.log
ls legpdf/*.pdf | nice -n 19 xargs -P 5 -n 1 ionice -c3 python3 ocr_one.py
echo "$(date -u +%FT%TZ) OCR end: $(ls legocr | wc -l)" >> ocr.log
echo DONE > ocr.flag
