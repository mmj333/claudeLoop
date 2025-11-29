#!/usr/bin/env node

/**
 * Dashboard Schedule Module
 * Handles the visual schedule timeline and conditional messaging configuration
 */

const dashboardSchedule = {
  // Track schedule state - 1440 minutes in a day (24 * 60)
  scheduleMinutes: new Array(1440).fill(true),
  
  // Drag state
  dragState: {
    isDragging: false,
    startTime: null,
    activeTimeline: null,
    dragPreview: null,
    originalScheduleState: null,
    isRightClickDrag: false
  },

  /**
   * Initialize the schedule module
   */
  init: function() {
    // Initialize schedule array if needed
    if (!window.scheduleMinutes) {
      window.scheduleMinutes = this.scheduleMinutes;
    }
    
    // Initialize the timeline on load
    if (document.getElementById('schedule-timeline-am')) {
      this.initializeTimeline();
      this.setupEventHandlers();
      this.updateTimezoneDisplay();
    }
  },

  /**
   * Initialize the timeline visualization
   */
  initializeTimeline: function() {
    const timelineAM = document.getElementById('schedule-timeline-am');
    const timelinePM = document.getElementById('schedule-timeline-pm');
    
    if (!timelineAM || !timelinePM) return;
    
    timelineAM.innerHTML = '';
    timelinePM.innerHTML = '';
    
    // Draw continuous blocks for AM (0-720 minutes)
    this.drawTimelineBlocks(timelineAM, 0, 720);
    
    // Draw continuous blocks for PM (720-1440 minutes)
    this.drawTimelineBlocks(timelinePM, 720, 1440);
    
    // Set up drag handlers
    this.setupDragHandlers();
  },

  /**
   * Draw timeline blocks for a given time range
   */
  drawTimelineBlocks: function(timeline, startMinute, endMinute) {
    // Find continuous blocks of same state
    let blocks = [];
    let currentBlock = null;
    
    for (let minute = startMinute; minute < endMinute; minute++) {
      const isActive = window.scheduleMinutes[minute];
      
      if (!currentBlock || currentBlock.isActive !== isActive) {
        // Start new block
        currentBlock = {
          start: minute,
          end: minute + 1,
          isActive: isActive
        };
        blocks.push(currentBlock);
      } else {
        // Extend current block
        currentBlock.end = minute + 1;
      }
    }
    
    // Draw each block
    blocks.forEach(block => {
      const segment = document.createElement('div');
      const isAM = timeline.id === 'schedule-timeline-am';
      const baseMinute = isAM ? 0 : 720;
      
      const leftPercent = ((block.start - baseMinute) / 720) * 100;
      const widthPercent = ((block.end - block.start) / 720) * 100;
      
      segment.className = 'schedule-segment';
      segment.style.cssText = 
        'position: absolute;' +
        'left: ' + leftPercent + '%;' +
        'width: ' + widthPercent + '%;' +
        'height: 100%;' +
        'background: ' + (block.isActive ? 'var(--success)' : 'var(--danger)') + ';' +
        'opacity: 0.8;' +
        'transition: opacity 0.2s;';
      
      segment.onmouseenter = () => {
        segment.style.opacity = '1';
        this.showTimeTooltip(segment, block.start, block.end);
      };
      
      segment.onmouseleave = () => {
        segment.style.opacity = '0.8';
        this.hideTimeTooltip();
      };
      
      timeline.appendChild(segment);
    });
  },

  /**
   * Setup drag handlers for timeline interaction
   */
  setupDragHandlers: function() {
    const timelineAM = document.getElementById('schedule-timeline-am');
    const timelinePM = document.getElementById('schedule-timeline-pm');
    
    const self = this;
    
    [timelineAM, timelinePM].forEach(timeline => {
      if (!timeline) return;
      
      timeline.onmousedown = (e) => {
        // Handle both left and right click drag
        e.preventDefault();
        self.dragState.isDragging = true;
        self.dragState.isRightClickDrag = (e.button === 2); // Right-click detected
        self.dragState.activeTimeline = timeline;
        self.dragState.startTime = self.getTimeFromX(e.clientX, timeline);
        // Capture the original minute-level state before any changes
        self.dragState.originalScheduleState = [...window.scheduleMinutes];
        self.updateTooltip(e, timeline);
        self.updateRange(self.dragState.startTime, self.dragState.startTime, true); // Initial click
      };
      
      // Prevent context menu on right click
      timeline.oncontextmenu = (e) => e.preventDefault();
      
      timeline.onmousemove = (e) => {
        self.updateTooltip(e, timeline);
        
        if (self.dragState.isDragging && self.dragState.activeTimeline === timeline) {
          const currentTime = self.getTimeFromX(e.clientX, timeline);
          self.updateRange(self.dragState.startTime, currentTime, false);
        }
      };
      
      timeline.onmouseup = (e) => {
        if (self.dragState.isDragging && self.dragState.activeTimeline === timeline) {
          const endTime = self.getTimeFromX(e.clientX, timeline);
          self.updateRange(self.dragState.startTime, endTime, true); // Final update
          self.dragState.isDragging = false;
          self.dragState.isRightClickDrag = false;
          self.dragState.activeTimeline = null;
          self.dragState.originalScheduleState = null;
        }
      };
      
      timeline.onmouseleave = () => {
        self.hideTooltip();
        // Don't cancel drag when leaving - allow dragging past edges
      };
    });
    
    // Global mouse move to handle dragging outside timeline
    document.addEventListener('mousemove', (e) => {
      if (self.dragState.isDragging && self.dragState.activeTimeline) {
        // Continue drag even outside timeline
        const currentTime = self.getTimeFromX(e.clientX, self.dragState.activeTimeline);
        self.updateRange(self.dragState.startTime, currentTime, false);
      }
    });
    
    // Global mouse up to handle drag end outside timeline
    document.addEventListener('mouseup', (e) => {
      if (self.dragState.isDragging && self.dragState.activeTimeline) {
        // Final update with current position
        const endTime = self.getTimeFromX(e.clientX, self.dragState.activeTimeline);
        self.updateRange(self.dragState.startTime, endTime, true);
        
        self.dragState.isDragging = false;
        self.dragState.isRightClickDrag = false;
        self.dragState.activeTimeline = null;
        self.dragState.originalScheduleState = null;
      }
    });
  },

  /**
   * Get time from mouse X position
   */
  getTimeFromX: function(clientX, timeline) {
    const rect = timeline.getBoundingClientRect();
    const x = clientX - rect.left;
    let percent = x / rect.width;
    
    const isAM = timeline.id === 'schedule-timeline-am';
    const baseHour = isAM ? 0 : 12;
    
    // When dragging past edges, clamp to the timeline's range
    if (x < 0) {
      return baseHour; // Snap to start of timeline
    } else if (x > rect.width) {
      return baseHour + 11.999; // Snap to end of timeline (just before next period)
    }
    
    // Normal case - calculate position within timeline
    percent = Math.max(0, Math.min(1, percent));
    return baseHour + (percent * 12);
  },

  /**
   * Update range based on drag
   */
  updateRange: function(startTime, endTime, isFinal) {
    const precision = parseInt(document.getElementById('schedule-precision')?.value || '15');
    const tool = document.querySelector('input[name="schedule-tool"]:checked')?.value || 'active';
    // For right-click drag, use opposite tool
    const isActive = this.dragState.isRightClickDrag ? (tool === 'inactive') : (tool === 'active');
    const isInitialDrag = Math.abs(endTime - startTime) < 0.01;
    
    // For finer control, snap to precision minutes
    const snapToMinutes = (time) => {
      const totalMinutes = time * 60;
      return Math.floor(totalMinutes / precision) * precision / 60;
    };
    
    const snappedStart = snapToMinutes(startTime);
    const snappedEnd = snapToMinutes(endTime);
    
    // If dragging backward, ensure we handle it properly
    const minTime = Math.min(snappedStart, snappedEnd);
    const maxTime = Math.max(snappedStart, snappedEnd);
    
    // First, restore the original state (for smooth drag experience)
    if (this.dragState.originalScheduleState && !isInitialDrag) {
      // Restore from saved minute array
      window.scheduleMinutes = [...this.dragState.originalScheduleState];
    }
    
    // Then apply the new selection at minute precision
    const startMinute = Math.max(0, Math.floor(minTime * 60));
    // Ensure we don't go past the end of the day (1440 minutes)
    const endMinute = Math.min(1440, Math.ceil((maxTime + (precision / 60)) * 60));
    
    for (let minute = startMinute; minute < endMinute; minute++) {
      if (minute >= 0 && minute < 1440) {
        window.scheduleMinutes[minute] = isActive;
      }
    }
    
    // Visual preview during drag (lightweight)
    if (!isFinal && this.dragState.activeTimeline) {
      this.updateDragPreview(this.dragState.activeTimeline, minTime, maxTime, isActive);
    } else {
      // Final update - full redraw
      if (this.dragState.dragPreview) {
        this.dragState.dragPreview.remove();
        this.dragState.dragPreview = null;
      }
      this.initializeTimeline();
    }
  },

  /**
   * Update drag preview overlay
   */
  updateDragPreview: function(timeline, minTime, maxTime, isActive) {
    // Remove old preview
    if (this.dragState.dragPreview) {
      this.dragState.dragPreview.remove();
    }
    
    // Create new preview
    const preview = document.createElement('div');
    preview.className = 'drag-preview';
    
    const isAM = timeline.id === 'schedule-timeline-am';
    const baseHour = isAM ? 0 : 12;
    const rangeStart = minTime - baseHour;
    const rangeEnd = maxTime - baseHour;
    
    const leftPercent = (rangeStart / 12) * 100;
    const widthPercent = ((rangeEnd - rangeStart) / 12) * 100;
    
    preview.style.cssText = 
      'position: absolute;' +
      'left: ' + leftPercent + '%;' +
      'width: ' + widthPercent + '%;' +
      'height: 100%;' +
      'background: ' + (isActive ? 'var(--success)' : 'var(--danger)') + ';' +
      'opacity: 0.5;' +
      'pointer-events: none;' +
      'z-index: 1000;';
    
    timeline.appendChild(preview);
    this.dragState.dragPreview = preview;
  },

  /**
   * Update tooltip on mouse move
   */
  updateTooltip: function(e, timeline) {
    const time = this.getTimeFromX(e.clientX, timeline);
    const hour = Math.floor(time);
    const minutes = Math.floor((time - hour) * 60);
    
    const formatTime = (h, m) => {
      const hour12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
      const ampm = h < 12 ? 'AM' : 'PM';
      return hour12 + ':' + (m < 10 ? '0' + m : m) + ' ' + ampm;
    };
    
    const tooltip = document.getElementById('time-tooltip');
    if (tooltip) {
      tooltip.textContent = formatTime(hour, minutes);
      tooltip.style.display = 'block';
      
      const rect = timeline.getBoundingClientRect();
      const x = e.clientX - rect.left;
      tooltip.style.left = (x - 30) + 'px';
    }
  },

  /**
   * Hide tooltip
   */
  hideTooltip: function() {
    const tooltip = document.getElementById('time-tooltip');
    if (tooltip) {
      tooltip.style.display = 'none';
    }
  },

  /**
   * Show time tooltip
   */
  showTimeTooltip: function(element, startMinute, endMinute) {
    const tooltip = document.getElementById('time-tooltip');
    if (!tooltip) return;
    
    const startHour = Math.floor(startMinute / 60);
    const startMin = startMinute % 60;
    const endHour = Math.floor(endMinute / 60);
    const endMin = endMinute % 60;
    
    const formatTime = (h, m) => {
      const hour = h === 0 ? 12 : (h > 12 ? h - 12 : h);
      const ampm = h < 12 ? 'AM' : 'PM';
      return hour + ':' + (m < 10 ? '0' + m : m) + ' ' + ampm;
    };
    
    tooltip.textContent = formatTime(startHour, startMin) + ' - ' + formatTime(endHour, endMin);
    tooltip.style.display = 'block';
    
    // Position tooltip
    const rect = element.getBoundingClientRect();
    const parentRect = element.parentElement.getBoundingClientRect();
    tooltip.style.left = (rect.left - parentRect.left + rect.width / 2 - 50) + 'px';
  },

  /**
   * Hide time tooltip
   */
  hideTimeTooltip: function() {
    const tooltip = document.getElementById('time-tooltip');
    if (tooltip) {
      tooltip.style.display = 'none';
    }
  },

  /**
   * Update timezone display
   */
  updateTimezoneDisplay: function() {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tzDisplay = document.getElementById('timezone-display');
    if (tzDisplay) {
      tzDisplay.textContent = 'Timezone: ' + tz + ' (all times shown in local time)';
    }
  },

  /**
   * Set all hours active or inactive
   */
  setAllHours: function(active) {
    for (let i = 0; i < 1440; i++) {
      window.scheduleMinutes[i] = active;
    }
    this.initializeTimeline();
    if (window.saveConfig) window.saveConfig();
  },

  /**
   * Set work hours (9-5)
   */
  setWorkHours: function() {
    // Clear all first
    for (let i = 0; i < 1440; i++) {
      window.scheduleMinutes[i] = false;
    }
    // Set 9 AM to 5 PM
    for (let i = 540; i < 1020; i++) { // 9*60 to 17*60
      window.scheduleMinutes[i] = true;
    }
    this.initializeTimeline();
    if (window.saveConfig) window.saveConfig();
  },

  /**
   * Set night hours (8 PM to 2 AM)
   */
  setNightHours: function() {
    // Clear all first
    for (let i = 0; i < 1440; i++) {
      window.scheduleMinutes[i] = false;
    }
    // Set 8 PM to midnight
    for (let i = 1200; i < 1440; i++) { // 20*60 to 24*60
      window.scheduleMinutes[i] = true;
    }
    // Set midnight to 2 AM
    for (let i = 0; i < 120; i++) { // 0 to 2*60
      window.scheduleMinutes[i] = true;
    }
    this.initializeTimeline();
    if (window.saveConfig) window.saveConfig();
  },

  /**
   * Setup event handlers for buttons and controls
   */
  setupEventHandlers: function() {
    // Tool selection
    const toolRadios = document.querySelectorAll('input[name="schedule-tool"]');
    toolRadios.forEach(radio => {
      radio.addEventListener('change', () => {
        this.dragState.activeTool = radio.value;
      });
    });

    // Precision selector
    const precisionSelect = document.getElementById('schedule-precision');
    if (precisionSelect) {
      precisionSelect.addEventListener('change', () => {
        // Save config when precision changes
        if (window.saveConfig) {
          window.saveConfig();
        }
      });
    }
  },

  /**
   * Check if schedule is active at current time
   */
  isScheduleActive: function() {
    const now = new Date();
    const currentMinute = now.getHours() * 60 + now.getMinutes();
    return window.scheduleMinutes[currentMinute] || false;
  }
};

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = dashboardSchedule;
}

// Make available globally in browser
if (typeof window !== 'undefined') {
  window.dashboardSchedule = dashboardSchedule;
}