import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

let engine: Promise<typeof import('pdfjs-dist')> | undefined;

/** Share one lazy engine between readers, annotations and canvas previews. */
export function loadPdfEngine() {
  return engine ??= import('pdfjs-dist').then(pdf => {
    pdf.GlobalWorkerOptions.workerSrc = workerUrl;
    return pdf;
  }).catch(error => {
    engine = undefined;
    const message = String(error?.message || error);
    if (/importing a module|failed to fetch dynamically imported module|error loading dynamically imported module|failed to load module script/i.test(message)) {
      throw new Error('The PDF reader could not load its module. Save your notes, then close and reopen Kavot to load the current version.');
    }
    throw error;
  });
}
