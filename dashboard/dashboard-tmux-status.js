/**
 * Dashboard Tmux Status Module
 * Provides a compact, filterable view of tmux command prompts and results
 */

const dashboardTmuxStatus = {
  // State
  isExpanded: false,
  refreshInterval: null,
  
  /**
   * Initialize the tmux status module
   */
  init() {
    console.log('[TmuxStatus] Module initialized');
    // No longer start our own refresh - we'll be updated by the main tmux refresh
  },
  
  /**
   * Toggle between compact and expanded view
   */
  toggle() {
    this.isExpanded = !this.isExpanded;
    const content = document.getElementById('tmux-status-content');
    const toggle = document.getElementById('tmux-status-toggle');
    
    if (!content || !toggle) return;
    
    if (this.isExpanded) {
      content.style.height = '200px';
      toggle.innerHTML = '▲ Collapse';
    } else {
      content.style.height = '80px';
      toggle.innerHTML = '▼ Expand';
    }
  },
  
  /**
   * DEPRECATED - Use filterProcessedContent instead
   * @param {string} rawContent - Raw tmux output with ANSI codes
   * @returns {string} Filtered content as HTML
   */
  filterContent_OLD(rawContent) {
    if (!rawContent) return '';
    
    // First convert ANSI to HTML using the existing utility
    const htmlContent = window.dashboardUtils ? 
      window.dashboardUtils.convertAnsiToHtml(rawContent) : 
      this.fallbackAnsiToHtml(rawContent);
    
    // Now split by line and filter
    const lines = htmlContent.split('\n');
    const filteredLines = [];
    let inBox = false;
    let boxType = null; // 'welcome', 'prompt', 'options'
    let captureNext = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Check if this line contains prompt characters (check the actual text, not HTML)
      const plainText = line.replace(/<[^>]*>/g, ''); // Strip HTML tags for checking
      
      // Look for the start of any box
      if (plainText.includes('╭─') && plainText.includes('─╮')) {
        // Determine what type of box this is by looking ahead
        let isWelcomeBox = false;
        let isPromptBox = false;
        let isOptionsBox = false;
        
        // Look at the next few lines to determine box type
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          const lookaheadText = lines[j].replace(/<[^>]*>/g, '');
          
          if (lookaheadText.includes('Welcome to Claude') || 
              lookaheadText.includes('✻ Welcome') ||
              lookaheadText.includes('/help for help')) {
            isWelcomeBox = true;
            break;
          }
          
          // Check for prompt indicator
          if (lookaheadText.includes('│') && lookaheadText.includes('>')) {
            isPromptBox = true;
            break;
          }
          
          // Check for option indicators (numbered items, selection markers)
          if (lookaheadText.match(/│\s*(1\.|2\.|3\.|•|▶|◯|●|\[|\])/)) {
            isOptionsBox = true;
            break;
          }
          
          // Stop looking if we hit the end of the box
          if (lookaheadText.includes('╰─') && lookaheadText.includes('─╯')) {
            break;
          }
        }
        
        // Skip welcome boxes entirely
        if (isWelcomeBox) {
          boxType = 'welcome';
          inBox = true;
          continue;
        }
        
        // Capture prompt and option boxes
        if (isPromptBox || isOptionsBox) {
          boxType = isPromptBox ? 'prompt' : 'options';
          inBox = true;
          filteredLines.push(line);
          continue;
        }
        
        // If we can't determine the type, assume it might be important
        boxType = 'unknown';
        inBox = true;
        filteredLines.push(line);
        continue;
      }
      
      // If we're in a box, handle accordingly
      if (inBox) {
        // Skip welcome box content
        if (boxType === 'welcome') {
          if (plainText.includes('╰─') && plainText.includes('─╯')) {
            inBox = false;
            boxType = null;
          }
          continue;
        }
        
        // Capture all content from prompt and option boxes
        filteredLines.push(line);
        
        // Check for end of box
        if (plainText.includes('╰─') && plainText.includes('─╯')) {
          inBox = false;
          // After important boxes, capture some output
          if (boxType === 'prompt') {
            captureNext = 5; // Capture command output
          } else if (boxType === 'options') {
            captureNext = 3; // Capture user's selection result
          }
          boxType = null;
        }
        continue;
      }
      
      // Capture lines after boxes (command output, status messages)
      if (captureNext > 0) {
        // Include the line if it has content or if we're still in the important zone
        if (plainText.trim() || captureNext > 2) {
          filteredLines.push(line);
        }
        captureNext--;
        continue;
      }
      
      // Only capture standalone important messages if we're not in a box and not capturing
      // This prevents random text from being included
      if (!inBox && captureNext === 0 && this.isImportantMessage(plainText)) {
        // Also capture standalone important status messages
        filteredLines.push(line);
      }
    }
    
    // Return the last 40 lines to show more context (since boxes can be tall)
    // (from the bottom 300 lines of tmux output we're searching)
    return filteredLines.slice(-40).join('\n');
  },
  
  /**
   * Fallback ANSI to HTML conversion if dashboardUtils isn't available
   */
  fallbackAnsiToHtml(text) {
    // Simple HTML escaping as fallback
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },
  
  /**
   * Check if a line contains important status information
   * @param {string} line - Line to check
   * @returns {boolean}
   */
  isImportantMessage(line) {
    const keywords = [
      'Error', 'error', 'ERROR',
      'Warning', 'warning', 'WARNING',
      'Success', 'success', 'SUCCESS',
      'Failed', 'failed', 'FAILED',
      'Complete', 'complete', 'COMPLETE',
      '✓', '✗', '→', '⚠️', '❌', '✅'
    ];
    
    return keywords.some(keyword => line.includes(keyword));
  },
  
  
  /**
   * Update the tmux status display with already-processed HTML content
   * This is called by the main tmux refresh to avoid duplicate API calls
   * @param {string} htmlContent - HTML content with ANSI already converted
   */
  updateFromProcessedContent(htmlContent) {
    const statusContent = document.getElementById('tmux-status-content');
    
    if (!statusContent) return;
    
    if (!htmlContent) {
      statusContent.innerHTML = '<div style="color: var(--text-secondary); font-size: 11px;">No tmux output</div>';
      return;
    }
    
    // Filter the already-processed HTML content
    const filteredHtml = this.filterProcessedContent(htmlContent);
    
    if (filteredHtml) {
      // Use the same format as the main tmux viewer
      statusContent.innerHTML = `<pre style="margin: 0; font-family: inherit; white-space: pre-wrap; word-wrap: break-word;">${filteredHtml}</pre>`;
      
      // Auto-scroll to bottom if not manually scrolled up
      const isNearBottom = Math.abs(statusContent.scrollHeight - statusContent.scrollTop - statusContent.clientHeight) < 50;
      if (isNearBottom) {
        statusContent.scrollTop = statusContent.scrollHeight;
      }
    } else {
      statusContent.innerHTML = '<div style="color: var(--text-secondary); font-size: 11px;">No recent commands</div>';
    }
  },
  
  /**
   * Filter already-processed HTML content (no ANSI conversion needed)
   * Searches from bottom to top for efficiency
   * @param {string} htmlContent - HTML content with ANSI already converted
   * @returns {string} Filtered HTML content
   */
  filterProcessedContent(htmlContent) {
    if (!htmlContent) return '';
    
    // Split by lines
    const lines = htmlContent.split('\n');
    const collectedBoxes = []; // Will store complete boxes and their output
    let currentBox = [];
    let inBox = false;
    let afterBoxLines = [];
    let boxCount = 0;
    const maxBoxes = 3; // Show up to 3 recent boxes
    
    // First pass: Search from bottom to top for boxes
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      const plainText = line.replace(/<[^>]*>/g, ''); // Strip HTML tags for checking
      
      // Check if this is the END of a box (searching backwards)
      if (plainText.includes('╰─') && plainText.includes('─╯')) {
        // Start collecting this box (remember we're going backwards)
        if (afterBoxLines.length > 0) {
          // Save any lines we collected after this box
          currentBox = afterBoxLines.slice(0, 5); // Take up to 5 lines after the box
          afterBoxLines = [];
        }
        currentBox.unshift(line); // Add to beginning since we're going backwards
        inBox = true;
        continue;
      }
      
      // If we're collecting a box
      if (inBox) {
        currentBox.unshift(line); // Add to beginning
        
        // Check if this is the START of the box
        if (plainText.includes('╭─') && plainText.includes('─╮')) {
          // We've collected a complete box
          // Check what type of box this is
          const boxText = currentBox.join('\n');
          const isWelcomeBox = boxText.includes('Welcome to Claude') || 
                               boxText.includes('✻ Welcome') ||
                               boxText.includes('/help for help');
          
          if (!isWelcomeBox) {
            // Any non-welcome box is important - just add it
            collectedBoxes.unshift(currentBox);
            boxCount++;
            
            // Stop if we've collected enough boxes
            if (boxCount >= maxBoxes) {
              break;
            }
          }
          
          // Reset for next box
          currentBox = [];
          inBox = false;
        }
        continue;
      }
      
      // If we're not in a box, collect lines that might be output after a box
      // (these will be associated with the box above them when we find it)
      if (!inBox && afterBoxLines.length < 10) {
        // Only collect non-empty lines or important messages
        if (plainText.trim() || this.isImportantMessage(plainText)) {
          afterBoxLines.unshift(line);
        }
      }
    }
    
    // If we found boxes, return them
    if (collectedBoxes.length > 0) {
      const result = collectedBoxes.flat().join('\n');
      const resultLines = result.split('\n');
      if (resultLines.length > 50) {
        return resultLines.slice(-50).join('\n');
      }
      return result;
    }
    
    // Second pass: If no boxes found, look for standalone help menus or numbered lists
    const standaloneContent = this.findStandaloneMenus(lines);
    if (standaloneContent) {
      return standaloneContent;
    }
    
    // If nothing found, return empty
    return '';
  },
  
  /**
   * Find standalone help menus or numbered lists (not in boxes)
   * @param {string[]} lines - All lines of content
   * @returns {string} Filtered content or empty string
   */
  findStandaloneMenus(lines) {
    // First, do a quick check of the bottom 12 lines for any slash commands
    let foundSlashInFirst12 = false;
    const checkLimit = Math.min(12, lines.length);
    
    for (let i = lines.length - 1; i >= lines.length - checkLimit; i--) {
      const plainText = lines[i].replace(/<[^>]*>/g, '');
      // Skip box lines
      if (plainText.includes('│') || plainText.includes('╭') || plainText.includes('╰')) {
        continue;
      }
      if (plainText.match(/^\s*\/\w+/)) {
        foundSlashInFirst12 = true;
        break;
      }
    }
    
    // If no slash commands in first 12 lines, skip help menu search entirely
    if (!foundSlashInFirst12) {
      // Jump straight to numbered list search
      // (numbered list code continues below)
    } else {
      // We found a slash in first 12 lines, so search for help menu (but limit to 50 lines)
      const bottomContent = [];
      let foundHelpMenu = false;
      let gapLines = 0;
      const maxGap = 2;
      const maxSearchLines = 50;
      let linesSearched = 0;
      
      // Search from bottom to find where help menu ends
      for (let i = lines.length - 1; i >= 0 && linesSearched < maxSearchLines; i--, linesSearched++) {
        const line = lines[i];
        const plainText = line.replace(/<[^>]*>/g, '');
        
        // Always add to our bottom content collection (we're going backwards)
        bottomContent.unshift(line);
        
        // Skip lines that are part of boxes
        if (plainText.includes('│') || plainText.includes('╭') || plainText.includes('╰')) {
          // If we found a help menu, stop here
          if (foundHelpMenu) {
            break;
          }
          continue;
        }
        
        // Check for help menu commands (starting with /)
        if (plainText.match(/^\s*\/\w+/)) {
          foundHelpMenu = true;
          gapLines = 0; // Reset gap counter
        } else if (foundHelpMenu) {
          // We're in help menu territory but hit a non-slash line
          gapLines++;
          
          if (gapLines > maxGap) {
            // Check if there's another slash command coming within the next few lines
            let hasMoreSlashCommands = false;
            for (let j = i - 1; j >= Math.max(0, i - 3) && j >= lines.length - maxSearchLines; j--) {
              if (lines[j].replace(/<[^>]*>/g, '').match(/^\s*\/\w+/)) {
                hasMoreSlashCommands = true;
                break;
              }
            }
            
            if (!hasMoreSlashCommands) {
              // No more slash commands coming, we've found the end of the help menu
              // Remove the extra lines we collected at the top (before the help menu started)
              const trimmedContent = bottomContent.slice(-bottomContent.length + gapLines - 1);
              return trimmedContent.join('\n');
            }
          }
        }
      }
      
      // If we found a help menu within our search limit, return it
      if (foundHelpMenu) {
        return bottomContent.join('\n');
      }
    }
    
    // Otherwise, look for numbered lists
    const collected = [];
    let foundNumberedList = false;
    
    // Search from bottom to top for "1." that has "2." nearby
    for (let i = lines.length - 1; i >= 0; i--) {
      const plainText = lines[i].replace(/<[^>]*>/g, '');
      
      // Skip box lines
      if (plainText.includes('│') || plainText.includes('╭') || plainText.includes('╰')) {
        continue;
      }
      
      if (plainText.match(/[❯>]?\s*1\./)) {
        // Found a "1.", now check if "2." appears within the next 4 lines
        let hasTwo = false;
        for (let j = i + 1; j <= Math.min(i + 4, lines.length - 1); j++) {
          const nextLineText = lines[j].replace(/<[^>]*>/g, '');
          if (nextLineText.match(/[❯>]?\s*2\./)) {
            hasTwo = true;
            break;
          }
        }
        
        if (hasTwo) {
          // This is a real numbered list!
          foundNumberedList = true;
          
          // Collect from "1." to the bottom (or until we stop seeing numbers/content)
          for (let j = i; j < lines.length; j++) {
            const lineText = lines[j].replace(/<[^>]*>/g, '');
            
            // Stop if we hit a box
            if (lineText.includes('│') || lineText.includes('╭') || lineText.includes('╰')) {
              break;
            }
            
            // Stop if we hit an empty line after collecting some items
            if (collected.length > 2 && !lineText.trim()) {
              break;
            }
            
            collected.push(lines[j]);
          }
          
          // Add just the header line (one line above "1.")
          if (i > 0) {
            const headerLine = lines[i - 1];
            const headerText = headerLine.replace(/<[^>]*>/g, '');
            // Only add if it's not a box line and has content
            if (!headerText.includes('│') && !headerText.includes('╭') && !headerText.includes('╰') && headerText.trim()) {
              collected.unshift(headerLine);
            }
          }
          
          // We found and processed a numbered list, so stop searching
          break;
        }
      }
    }
    
    if (collected.length >= 2) {
      return collected.join('\n');
    }
    
    return '';
  },
  
  
  /**
   * Clean up when module is destroyed
   */
  destroy() {
    // Nothing to clean up now that we don't have our own refresh interval
  }
};

// Export for use in dashboard
if (typeof module !== 'undefined' && module.exports) {
  module.exports = dashboardTmuxStatus;
}

// Make available globally for browser
if (typeof window !== 'undefined') {
  window.dashboardTmuxStatus = dashboardTmuxStatus;
}