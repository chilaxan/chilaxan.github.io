var win=window.open(
     "about:blank",
     "JSEmbed",
     "resizeable,scrollbars"
);
win.document.write('
  <style>
    .frame-area {
        display: block;
        width: 100%;
        height: 100%;
        overflow: hidden;
        border: 0px;
        margin: 0px;
        padding: 0p;
    }
    </style>
    <iframe class="frame-area" src="https://chilaxan.github.io/gba/index.html" gesture="media"  allow="encrypted-media" allowfullscreen></iframe>
');
