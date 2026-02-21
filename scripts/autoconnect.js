// ==UserScript==
// @name         LinkedIn Auto Connect
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Automatically clicks all "Connect" buttons and scrolls to load more suggestions.
// @author       Mehran
// @match        https://www.linkedin.com/mynetwork/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = {
        minDelay: 2000, // Minimum delay between clicks (ms)
        maxDelay: 5000, // Maximum delay between clicks (ms)
        maxClicks: 100, // Maximum number of clicks per run
        scrollInterval: 3000 // How often to check for new content/scroll (ms)
    };

    let clickCount = 0;
    let isRunning = false;

    function getRandomDelay() {
        return Math.floor(Math.random() * (CONFIG.maxDelay - CONFIG.minDelay + 1)) + CONFIG.minDelay;
    }

    async function autoConnect() {
        if (!isRunning) return;

        // 1. Try to find and click "Load more" button if it exists
        const loadMoreBtn = Array.from(document.querySelectorAll('button')).find(btn => 
            btn.textContent.trim().toLowerCase() === 'load more' || 
            (btn.getAttribute('aria-label') && btn.getAttribute('aria-label').toLowerCase().includes('load more'))
        );
        
        if (loadMoreBtn) {
            console.log("Found 'Load more' button. Clicking...");
            loadMoreBtn.click();
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        // 2. Find all "Connect" buttons
        const connectButtons = Array.from(document.querySelectorAll('button')).filter(btn => {
            const ariaLabel = btn.getAttribute('aria-label') || '';
            return ariaLabel.startsWith('Invite') && ariaLabel.endsWith('to connect');
        });

        console.log(`Found ${connectButtons.length} connect buttons.`);

        if (connectButtons.length === 0) {
            console.log("No buttons found. Scrolling down to trigger loading...");
            window.scrollTo(0, document.body.scrollHeight);
            await new Promise(resolve => setTimeout(resolve, CONFIG.scrollInterval));
            autoConnect(); // Recursive call to try again after scroll
            return;
        }

        for (const btn of connectButtons) {
            if (clickCount >= CONFIG.maxClicks || !isRunning) {
                if (clickCount >= CONFIG.maxClicks) {
                    console.log("Reached maximum click limit.");
                    isRunning = false;
                    alert(`Finished! Sent ${clickCount} connection requests.`);
                }
                return;
            }

            // Click only if button is in view
            if (document.body.contains(btn) && btn.offsetParent !== null) {
                btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await new Promise(resolve => setTimeout(resolve, 500)); // Wait for scroll
                
                btn.click();
                clickCount++;
                console.log(`Clicked button ${clickCount}: ${btn.getAttribute('aria-label')}`);

                // Wait for a random delay
                await new Promise(resolve => setTimeout(resolve, getRandomDelay()));
            }
        }

        // After clicking visible buttons, scroll to the very bottom to trigger more results
        console.log("Completed current batch. Scrolling to bottom...");
        window.scrollTo(0, document.body.scrollHeight);
        
        // Wait for content to load and then continue
        setTimeout(autoConnect, CONFIG.scrollInterval);
    }

    // UI elements
    const startBtn = document.createElement('button');
    startBtn.innerHTML = 'Start Auto Connect';
    startBtn.style.position = 'fixed';
    startBtn.style.top = '80px';
    startBtn.style.right = '20px';
    startBtn.style.zIndex = '10000';
    startBtn.style.padding = '12px 20px';
    startBtn.style.backgroundColor = '#0a66c2';
    startBtn.style.color = '#ffffff';
    startBtn.style.border = 'none';
    startBtn.style.borderRadius = '24px';
    startBtn.style.fontWeight = 'bold';
    startBtn.style.fontSize = '14px';
    startBtn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
    startBtn.style.cursor = 'pointer';

    startBtn.onclick = () => {
        if (!isRunning) {
            if (confirm('Start sending auto connection requests? This will click up to 100 buttons and scroll automatically.')) {
                isRunning = true;
                startBtn.style.backgroundColor = '#cc0000';
                startBtn.innerHTML = 'Stop Auto Connect';
                autoConnect();
            }
        } else {
            isRunning = false;
            startBtn.style.backgroundColor = '#0a66c2';
            startBtn.innerHTML = 'Start Auto Connect';
            console.log('Script stopped by user.');
        }
    };

    document.body.appendChild(startBtn);
    console.log('LinkedIn Auto Connect script v1.1 loaded.');
})();
