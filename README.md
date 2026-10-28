# RSSFlicks

This is a dirty vibe-coded RSS app that allows playing videos shared by RSS feeds. 

While there is the awesome <a href="https://archivewatch.org/">archivewatch.org</a> this app is purely
client-side now server (besides the RSS and video hoster) is involved. All state is in your local browser.

The app allows to choose from a pre-defined feed catalog or to add custom feeds.

## The CORS problem

The app only becomes really useful with a browser extension to allow CORS. CORS is a browser standard 
protecting the use case of big social media and hinders building simple JS client apps accessing our 
user data stored within their services. This way CORS is a gatekeeping standard.

This is why RSSFlicks relies on browser extension for example 

- [CORS everywhere](https://addons.mozilla.org/en-US/firefox/addon/cors-everywhere/) (for Firefox)
- [Allow CORS](https://chromewebstore.google.com/detail/allow-cors-access-control/lhobafahddgcelffkeicbaginigeejlf?hl=en) (for Chrome)

to subscribe to Youtube feeds.

## PoC only

This is only a PoC to show what can be done with RSS, vanilla JS, minimal dependencies and using client code only!

## Usage

For testing

     git submodule init
     git submodule update

     npm start
     
or use the Github pages deployment workflow.
