

export function interfaceIcon(name, className = "") {
  const paths = {
    calendar: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v5m8-5v5M4 11h16m-11 4h2m3 0h2"/>',
    archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8m-9 4h4"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/>',
    trash: '<path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    edit: '<path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14Z"/>',
    link: '<path d="m10 14 4-4m-6 6-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>',
    folder:
      '<path d="M3.5 7.5h6l1.8 2H20a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18V9A1.5 1.5 0 0 1 4 7.5Z"/><path d="M3.5 7.5V6A1.5 1.5 0 0 1 5 4.5h4l2 2h5"/>',
    markdown:
      '<path d="M6 2.75h8l4 4V21.25H6Z"/><path d="M14 2.75v4h4M8.5 16v-5l2 2 2-2v5m2-2 1.5 2 1.5-2"/>',
    pdf: '<path d="M6 2.75h8l4 4V21.25H6Z"/><path d="M14 2.75v4h4M8 16v-4h1.25a1.25 1.25 0 0 1 0 2.5H8m4 1.5v-4h1a2 2 0 0 1 0 4Zm4 0v-4h2"/>',
    canvas: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="9" r="2"/><circle cx="16" cy="15" r="2"/><path d="m10 10.5 4 3"/>',
    graph: '<circle cx="6" cy="6" r="2.25"/><circle cx="18" cy="8" r="2.25"/><circle cx="9" cy="18" r="2.25"/><path d="m8.1 6.6 7.7 1M7 8.1l1.4 7.7m2.3.9 5.6-7"/>',
    image:
      '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m5 18 4.5-4.5 3 3 2-2 4.5 3.5"/>',
    json: '<path d="M8.5 3.5c-2 0-2 1.5-2 3.5v2c0 1.5-1 2-2 2 1 0 2 .5 2 2v2c0 2 0 3.5 2 3.5m7-15c2 0 2 1.5 2 3.5v2c0 1.5 1 2 2 2-1 0-2 .5-2 2v2c0 2 0 3.5-2 3.5"/>',
    file: '<path d="M6 2.75h8l4 4V21.25H6Z"/><path d="M14 2.75v4h4M9 12h6m-6 3h6m-6 3h4"/>',
    panels:
      '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
    grip: '<circle cx="8" cy="7" r="1"/><circle cx="16" cy="7" r="1"/><circle cx="8" cy="12" r="1"/><circle cx="16" cy="12" r="1"/><circle cx="8" cy="17" r="1"/><circle cx="16" cy="17" r="1"/>',
    note: '<path d="M6 3.5h9l3 3v14H6Z"/><path d="M15 3.5v3h3M9 11h6m-6 3h6m-6 3h4"/>',
    project:
      '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M8 5V3.5h8V5M8 10h8m-8 4h5"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
    template: '<path d="M5 3.5h14v17H5Z"/><path d="M8.5 8h7m-7 4h7m-7 4h4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    sparkle: '<path d="M12 2.5c.7 4.7 2.8 6.8 7.5 7.5-4.7.7-6.8 2.8-7.5 7.5-.7-4.7-2.8-6.8-7.5-7.5 4.7-.7 6.8-2.8 7.5-7.5Z"/><path d="M19 16.5c.25 1.7 1.05 2.5 2.5 2.75-1.45.25-2.25 1.05-2.5 2.75-.25-1.7-1.05-2.5-2.5-2.75 1.45-.25 2.25-1.05 2.5-2.75Z"/>',
    bulb: '<path d="M9 18h6m-5 3h4"/><path d="M8.5 15.5C7 14.4 6 12.5 6 10.5a6 6 0 1 1 12 0c0 2-1 3.9-2.5 5-.7.5-1 1.1-1 2h-5c0-.9-.3-1.5-1-2Z"/>',
    task: '<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="m8 9 1.5 1.5L12 8m2 1h3m-9 6 1.5 1.5L12 14m2 1h3"/>',
    database: '<ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6m-15 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/>',
    conference: '<path d="M4 20v-2.5A3.5 3.5 0 0 1 7.5 14h3a3.5 3.5 0 0 1 3.5 3.5V20"/><circle cx="9" cy="7.5" r="3.5"/><path d="M16 8h5m-2.5-2.5V11M16 15h5"/>',
    text: '<path d="M5 5h14M12 5v14m-4 0h8"/>',
    zone: '<rect x="3.5" y="4" width="17" height="16" rx="2" stroke-dasharray="3 3"/>',
    rectangle: '<rect x="3.5" y="5" width="17" height="14" rx="2"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>',
    diamond: '<path d="m12 3 9 9-9 9-9-9Z"/>',
    upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 14v6h16v-6"/>',
    zoomout: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M7.5 10.5h6m2 5 5 5"/>',
    zoomin: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M7.5 10.5h6m-3-3v6m5 2 5 5"/>',
    fit: '<path d="M9 4H4v5m11-5h5v5M9 20H4v-5m11 5h5v-5"/>',
    question: '<circle cx="12" cy="12" r="9"/><path d="M9.7 9a2.45 2.45 0 0 1 4.7 1c0 1.8-2.4 2-2.4 3.6M12 17.3h.01"/>',
    flask: '<path d="M9 3h6m-5 0v5l-5.5 9.2A2.5 2.5 0 0 0 6.7 21h10.6a2.5 2.5 0 0 0 2.2-3.8L14 8V3M7.5 16h9"/>',
    chart: '<path d="M5 20V10m5 10V4m5 16v-7m5 7V7"/>',
    draw: '<path d="m14.5 4.5 3 3L9.5 15.5l-3.5.5.5-3.5Z"/><path d="M4 20.5c2-1.2 3.5-2.5 5.5-2.5s2.5 1.5 4.5 1.5 3.5-1.5 6-2"/>',
    noteplus: '<path d="M13 3.5H6v17h12V8.5Z"/><path d="M13 3.5v5h5M12 11.5v6m-3-3h6"/>',
    tasks: '<path d="M8 4h12v16H4V8M2 4l3 3 5-5M8 11h8M8 16h8"/>',
    papers: '<path d="M5 4h14v17H5zM8 4V2h8v2M8 9h8M8 13h8M8 17h5"/>',
    folderplus: '<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z"/><path d="M12 10v6m-3-3h6"/>',
    chevron: '<path d="m9.5 6 6 6-6 6"/>',
    more: '<circle cx="5.5" cy="12" r="1.1"/><circle cx="12" cy="12" r="1.1"/><circle cx="18.5" cy="12" r="1.1"/>',
    collapse: '<path d="m7 20 5-5 5 5M7 4l5 5 5-5"/>',
  };
  return `<svg class="ui-icon ${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.file}</svg>`;
}
