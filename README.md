# Creative Content Creator Portfolio

## Run in VS Code
1. Unzip the folder and open it in VS Code (File > Open Folder).
2. Install the "Live Server" extension (Ritwick Dey).
3. Right-click `index.html` > "Open with Live Server".

## Edit your details
- Name: replace `Your<span>Name</span>` in `index.html` (appears in the header and footer).
- Photo: replace `assets/profile.jpg` (keep the file name).
- Project images: in each project card, replace the `<div class="thumb">...</div>` with
  `<div class="thumb"><img src="assets/project1.jpg" alt="Project name"><span class="tag">Category</span></div>`
  and add `.thumb img{width:100%;height:100%;object-fit:cover}` to style.css.
- Skill percentages: change `data-level="NN"` values.
- Contact form: it opens the visitor's email app (mailto). Change `EMAIL` in `script.js` to switch the address.

Fonts load from Google Fonts when online; the site falls back to system fonts offline.
