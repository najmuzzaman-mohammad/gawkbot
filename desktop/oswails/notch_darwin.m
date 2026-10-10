//go:build desktop && darwin && cgo

// The camera-notch surface for the gawkbot Mac app.
//
// A borderless, transparent, non-activating NSPanel sits over the MacBook's
// camera notch and hosts a WKWebView of <office>/notch.html (web/notch.html).
// Collapsed it is the notch plus two "ears" of animated gawkbots; on hover it
// taps the Force Touch trackpad and drops into a panel. Everything the page
// shows comes from the office over loopback HTTP — this file only does what a
// web page cannot: float over the menu bar on every Space, track the pointer,
// play haptics, take keyboard focus without stealing the active app, and
// open the main window.
//
// Contract with the page: web/src/notch/bridge.ts.
// Macs without a notch get a pill centred at the top of the screen instead.

#import <AVFoundation/AVFoundation.h>
#import <Carbon/Carbon.h>
#import <Cocoa/Cocoa.h>
#import <Speech/Speech.h>
#import <WebKit/WebKit.h>

#include "_cgo_export.h"
#include <dlfcn.h>
#include <unistd.h>

// The strip's ears, either side of the notch, in the menu bar. With a notch
// the strip is exactly the notch when nothing is going on; a thin band of
// coloured dots and spinners just under it while agents work; and compact
// ears with faces when something needs the human. All hug the notch's edges, clear of
// the menus further out. Without a notch the strip is a pill with ears.
static const CGFloat kEarWidth = 72.0;
static const CGFloat kCompactEarWidth = 40.0;
// At rest, agents at work show as a row of small dots and spinners in a
// thin band just under the notch, no wider than it. At most this tall.
static const CGFloat kMaxBandHeight = 14.0;
// The open panel. The page draws itself at exactly this size, so keep these
// equal to EXPANDED_WIDTH / EXPANDED_HEIGHT in web/src/notch/NotchView.tsx:
// a smaller window clips the composer and the shortcut footer.
static const CGFloat kExpandedWidth = 460.0;
static const CGFloat kExpandedHeight = 560.0;
// Matches the .notch-shell CSS transition, so the panel shrinks only after
// the page has finished animating closed.
static const NSTimeInterval kCollapseDelay = 0.3;
static const NSTimeInterval kHoverExitGrace = 0.25;
static const NSTimeInterval kPeekDuration = 4.0;
// While open, the pointer is also polled: tracking-area exit events are not
// guaranteed when the area is rebuilt with the cursor already inside it (the
// panel grows under the pointer on every expand).
static const NSTimeInterval kHoverPollInterval = 0.2;
// Most room the page may ask for below the collapsed strip (peeks, chatter).
static const CGFloat kMaxStageHeight = 160.0;

// A panel that can take keyboard focus for the "message the Chief of Staff"
// box without activating the app (NSWindowStyleMaskNonactivatingPanel), the
// same way Spotlight does.
@interface GawkNotchPanel : NSPanel
@end

@implementation GawkNotchPanel
- (BOOL)canBecomeKeyWindow {
	return YES;
}
- (BOOL)canBecomeMainWindow {
	return NO;
}
// AppKit keeps windows below the menu bar by moving them down when they are
// placed. The notch IS in the menu bar's row: left alone, the strip landed
// one row lower, under the camera housing and over other apps' own top
// edge. The frame asked for is the frame it gets.
- (NSRect)constrainFrameRect:(NSRect)frameRect toScreen:(NSScreen *)screen {
	(void)screen;
	return frameRect;
}
@end

// Hosts the web view and owns the hover tracking area.
@interface GawkNotchContentView : NSView
@property(nonatomic, weak) id hoverOwner;
// Collapsed, only the black strip (the top stripHeight points) opens the
// panel on hover; the transparent stage below it must not. Expanded, the
// whole panel counts.
@property(nonatomic) CGFloat stripHeight;
@property(nonatomic) BOOL coversAll;
@end

@implementation GawkNotchContentView
- (void)updateTrackingAreas {
	[super updateTrackingAreas];
	for (NSTrackingArea *area in [self.trackingAreas copy]) {
		[self removeTrackingArea:area];
	}
	if (self.hoverOwner == nil) {
		return;
	}
	NSRect bounds = self.bounds;
	NSRect rect = self.coversAll || self.stripHeight <= 0
		? bounds
		: NSMakeRect(0, NSHeight(bounds) - self.stripHeight, NSWidth(bounds), self.stripHeight);
	NSTrackingArea *area = [[NSTrackingArea alloc]
		initWithRect:rect
		     options:NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways
		       owner:self.hoverOwner
		    userInfo:nil];
	[self addTrackingArea:area];
}
@end

@interface GawkNotchController : NSObject <WKScriptMessageHandler, WKNavigationDelegate>
@property(nonatomic, strong) GawkNotchPanel *panel;
@property(nonatomic, strong) GawkNotchContentView *content;
@property(nonatomic, strong) WKWebView *webView;
// The open panel's material: real system glass behind the (transparent)
// web view. A page cannot blur the desktop behind its own window, so the
// sheet's glass has to be native. Hidden while collapsed.
@property(nonatomic, strong) NSView *glass;
@property(nonatomic, copy) NSString *officeURL;
@property(nonatomic) CGFloat notchWidth;
@property(nonatomic) CGFloat notchHeight;
@property(nonatomic) BOOL expanded;
@property(nonatomic) BOOL hovering;
@property(nonatomic) BOOL keyboardActive;
@property(nonatomic) NSUInteger generation;
@property(nonatomic, strong) NSTimer *hoverPoll;
// While open: a click anywhere outside the panel closes it, whatever it
// was doing (typing a reply, pinned open from the keyboard).
@property(nonatomic, strong) id outsideClickGlobal;
@property(nonatomic, strong) id outsideClickLocal;
@property(nonatomic, strong) NSDate *peekUntil;
@property(nonatomic) CGFloat stageHeight;
// On a Mac with a notch, how wide the ears are right now, as the page asks:
// 0 (exactly the notch), dots at rest, or faces when something needs you.
@property(nonatomic) CGFloat earsWidth;
// The band of dots under the notch, as the page asks: 0 or a few points.
@property(nonatomic) CGFloat bandHeight;
// Opened from the keyboard (the global hotkey): stays open until Esc or the
// hotkey again, even with the pointer elsewhere.
@property(nonatomic) BOOL pinned;
// Push-to-talk. Typed as id so the class compiles on macOS < 10.15, where
// the Speech framework is unavailable; every use is behind @available.
@property(nonatomic, strong) id speechRecognizer;
@property(nonatomic, strong) id speechRequest;
@property(nonatomic, strong) id speechTask;
@property(nonatomic, strong) AVAudioEngine *audioEngine;
@property(nonatomic) BOOL voiceActive;
// Widget-only mode: with the main window closed the app is just the notch,
// so it leaves the Dock; opening the full view brings the Dock icon back.
@property(nonatomic, strong) NSTimer *dockWatch;
- (void)hotkeyPressed;
@end

static GawkNotchController *gNotch;
static EventHotKeyRef gHotKey;

static OSStatus GawkHotKeyHandler(EventHandlerCallRef next, EventRef event, void *user) {
	(void)next;
	(void)event;
	(void)user;
	dispatch_async(dispatch_get_main_queue(), ^{
		[gNotch hotkeyPressed];
	});
	return noErr;
}

@implementation GawkNotchController

#pragma mark Geometry

// The built-in display is the one with a top safe-area inset (the notch).
// Falls back to the main screen on notch-less Macs and macOS < 12.
- (NSScreen *)notchScreen {
	if (@available(macOS 12.0, *)) {
		for (NSScreen *screen in [NSScreen screens]) {
			if (screen.safeAreaInsets.top > 0) {
				return screen;
			}
		}
	}
	return [NSScreen mainScreen] ?: [NSScreen screens].firstObject;
}

- (void)measure {
	NSScreen *screen = [self notchScreen];
	self.notchWidth = 0;
	// Menu bar height: what sits above the visible frame.
	CGFloat menuBar = NSMaxY(screen.frame) - NSMaxY(screen.visibleFrame);
	self.notchHeight = menuBar > 0 ? menuBar : 24;
	if (@available(macOS 12.0, *)) {
		CGFloat top = screen.safeAreaInsets.top;
		NSRect left = screen.auxiliaryTopLeftArea;
		NSRect right = screen.auxiliaryTopRightArea;
		if (top > 0 && !NSIsEmptyRect(left) && !NSIsEmptyRect(right)) {
			self.notchHeight = top;
			self.notchWidth = MAX(0, NSWidth(screen.frame) - NSWidth(left) - NSWidth(right));
		}
	}
}

- (CGFloat)earWidth {
	if (self.notchWidth <= 0) {
		return kEarWidth;
	}
	return self.earsWidth;
}

- (NSRect)frameExpanded:(BOOL)expanded {
	NSScreen *screen = [self notchScreen];
	CGFloat collapsedWidth = self.notchWidth + 2 * [self earWidth];
	CGFloat w = expanded ? MAX(kExpandedWidth, collapsedWidth) : collapsedWidth;
	CGFloat h = expanded ? kExpandedHeight : self.notchHeight + self.bandHeight + self.stageHeight;
	NSRect sf = screen.frame;
	return NSMakeRect(round(NSMidX(sf) - w / 2), NSMaxY(sf) - h, w, h);
}

- (NSURL *)pageURL {
	NSString *base = [self.officeURL hasSuffix:@"/"]
		? [self.officeURL substringToIndex:self.officeURL.length - 1]
		: self.officeURL;
	// glass=1 tells the page the sheet's material is drawn natively, so it
	// paints a light tint instead of an opaque sheet.
	NSString *s = [NSString stringWithFormat:@"%@/notch.html?nw=%.0f&nh=%.0f&ew=%.0f&glass=1",
		base, self.notchWidth, self.notchHeight, self.notchWidth > 0 ? kCompactEarWidth : kEarWidth];
	return [NSURL URLWithString:s];
}

#pragma mark Setup

- (void)start {
	[self measure];

	NSRect frame = [self frameExpanded:NO];
	self.panel = [[GawkNotchPanel alloc]
		initWithContentRect:frame
		          styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
		            backing:NSBackingStoreBuffered
		              defer:NO];
	self.panel.opaque = NO;
	self.panel.backgroundColor = [NSColor clearColor];
	self.panel.hasShadow = NO;
	// Above the menu bar so the ears can sit beside the camera housing.
	// The level is set after floatingPanel, which resets it to the floating
	// level (below the menu bar) when it is turned on.
	self.panel.floatingPanel = YES;
	self.panel.level = NSStatusWindowLevel;
	self.panel.hidesOnDeactivate = NO;
	// Closing the full view hides the whole application (Wails calls
	// [NSApp hide:] for HideWindowOnClose), and a hidden app hides every
	// window it owns. The notch is the part that stays: opt it out.
	self.panel.canHide = NO;
	self.panel.movable = NO;
	self.panel.becomesKeyOnlyIfNeeded = YES;
	self.panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
		NSWindowCollectionBehaviorStationary |
		NSWindowCollectionBehaviorFullScreenAuxiliary |
		NSWindowCollectionBehaviorIgnoresCycle;

	WKUserContentController *ucc = [[WKUserContentController alloc] init];
	[ucc addScriptMessageHandler:self name:@"gawkNotch"];
	WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
	config.userContentController = ucc;
	// The notification sounds are Web Audio; let them play without a click.
	if (@available(macOS 10.12, *)) {
		config.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;
	}

	self.content = [[GawkNotchContentView alloc] initWithFrame:NSMakeRect(0, 0, NSWidth(frame), NSHeight(frame))];
	self.content.autoresizesSubviews = YES;
	self.webView = [[WKWebView alloc] initWithFrame:self.content.bounds configuration:config];
	self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
	self.webView.navigationDelegate = self;
	// Transparent: only the page's black .notch-shell paints; the rest of
	// the panel shows the desktop through it.
	[self.webView setValue:@NO forKey:@"drawsBackground"];
	self.glass = [self makeGlass];
	self.glass.hidden = YES;
	[self.content addSubview:self.glass];
	[self.content addSubview:self.webView];
	self.content.hoverOwner = self;
	self.content.stripHeight = self.notchHeight + self.bandHeight;
	self.panel.contentView = self.content;

	[[NSNotificationCenter defaultCenter] addObserver:self
	                                         selector:@selector(screensChanged:)
	                                             name:NSApplicationDidChangeScreenParametersNotification
	                                           object:nil];

	[self.webView loadRequest:[NSURLRequest requestWithURL:[self pageURL]]];
	[self.panel orderFrontRegardless];
	[self registerHotKey];
	[self startDockWatch];
}

#pragma mark Widget-only mode

// Closing the main window hides it (HideWindowOnClose in main.go) rather
// than quitting, so the notch keeps running. This watch keeps the Dock icon
// honest: shown while the full view is open or minimised (minimised windows
// live in the Dock), gone when the notch is all there is. Polled rather than
// hooked so it does not depend on which Wails close path ran.
- (BOOL)fullViewIsOpen {
	for (NSWindow *window in [NSApp windows]) {
		if (window == self.panel) {
			continue;
		}
		if (window.isVisible || window.isMiniaturized) {
			return YES;
		}
	}
	return NO;
}

- (void)setDockVisible:(BOOL)visible {
	NSApplicationActivationPolicy want = visible ? NSApplicationActivationPolicyRegular
	                                            : NSApplicationActivationPolicyAccessory;
	if (NSApp.activationPolicy != want) {
		[NSApp setActivationPolicy:want];
	}
}

- (void)startDockWatch {
	__weak GawkNotchController *weakSelf = self;
	self.dockWatch = [NSTimer scheduledTimerWithTimeInterval:1.0
	                                                 repeats:YES
	                                                   block:^(NSTimer *timer) {
		(void)timer;
		GawkNotchController *strongSelf = weakSelf;
		if (strongSelf != nil) {
			[strongSelf setDockVisible:[strongSelf fullViewIsOpen]];
		}
	}];
}

// ⌃⌥Space opens the notch from anywhere, ready for the keyboard. Carbon's
// RegisterEventHotKey needs no Accessibility permission, unlike a global
// NSEvent monitor.
- (void)registerHotKey {
	EventTypeSpec spec = {kEventClassKeyboard, kEventHotKeyPressed};
	OSStatus status = InstallApplicationEventHandler(&GawkHotKeyHandler, 1, &spec, NULL, NULL);
	EventHotKeyID hotKeyID = {'gawk', 1};
	if (status == noErr) {
		status = RegisterEventHotKey(kVK_Space, controlKey | optionKey, hotKeyID, GetApplicationEventTarget(), 0, &gHotKey);
	}
	if (status != noErr) {
		// Another app already owns ⌃⌥Space, or Carbon refused. The notch
		// still opens on hover; only the keyboard shortcut is missing.
		NSLog(@"gawkbot notch: global hotkey ⌃⌥Space not registered (OSStatus %d)", (int)status);
	}
	goNotchHotKeyStatus((int)status);
}

- (void)hotkeyPressed {
	if (self.expanded && self.pinned) {
		self.pinned = NO;
		[self applyExpanded:NO animatePage:YES];
		return;
	}
	self.pinned = YES;
	[self applyExpanded:YES animatePage:YES];
	[self.webView evaluateJavaScript:@"window.gawkNotch && window.gawkNotch.focusKeyboard && window.gawkNotch.focusKeyboard()"
	               completionHandler:nil];
}

- (void)screensChanged:(NSNotification *)note {
	(void)note;
	[self measure];
	self.content.stripHeight = self.notchHeight + self.bandHeight;
	[self applyExpanded:NO animatePage:NO];
	[self.webView loadRequest:[NSURLRequest requestWithURL:[self pageURL]]];
}

#pragma mark Glass

// Matches --notch-radius in web/src/notch/notch.css.
static const CGFloat kGlassRadius = 22.0;
// Matches the .notch-shell height transition, so the glass grows with the
// sheet the page draws on it.
static const NSTimeInterval kGlassGrow = 0.36;

// A mask for the fallback material: square at the top (it sits under the
// black strip), rounded at the bottom.
static NSImage *GawkBottomRoundedMask(CGFloat radius) {
	CGFloat edge = radius * 2 + 1;
	NSImage *image = [NSImage imageWithSize:NSMakeSize(edge, edge)
	                                flipped:NO
	                         drawingHandler:^BOOL(NSRect rect) {
		NSBezierPath *path = [NSBezierPath bezierPath];
		[path moveToPoint:NSMakePoint(NSMinX(rect), NSMaxY(rect))];
		[path lineToPoint:NSMakePoint(NSMaxX(rect), NSMaxY(rect))];
		[path lineToPoint:NSMakePoint(NSMaxX(rect), NSMinY(rect) + radius)];
		[path appendBezierPathWithArcWithCenter:NSMakePoint(NSMaxX(rect) - radius, NSMinY(rect) + radius)
		                                 radius:radius startAngle:0 endAngle:270 clockwise:YES];
		[path lineToPoint:NSMakePoint(NSMinX(rect) + radius, NSMinY(rect))];
		[path appendBezierPathWithArcWithCenter:NSMakePoint(NSMinX(rect) + radius, NSMinY(rect) + radius)
		                                 radius:radius startAngle:270 endAngle:180 clockwise:YES];
		[path closePath];
		[[NSColor blackColor] setFill];
		[path fill];
		return YES;
	}];
	image.capInsets = NSEdgeInsetsMake(radius, radius, radius, radius);
	image.resizingMode = NSImageResizingModeStretch;
	return image;
}

// The system's own glass where it exists (macOS 26), the dark behind-window
// blur everywhere else.
//
// NSGlassEffectView is looked up by name, not named in the code: the release
// builds on an older SDK that does not declare it, and naming it there fails
// the build (it did, for v0.240.0). At run time on macOS 26 the class is
// there and this is the same view, set up through the same properties.
- (NSView *)makeGlass {
	Class glassClass = NSClassFromString(@"NSGlassEffectView");
	if (glassClass != Nil && [glassClass isSubclassOfClass:[NSView class]]) {
		NSView *glass = [[glassClass alloc] initWithFrame:NSZeroRect];
		if ([glass respondsToSelector:NSSelectorFromString(@"setCornerRadius:")] &&
		    [glass respondsToSelector:NSSelectorFromString(@"setTintColor:")]) {
			[glass setValue:@(kGlassRadius) forKey:@"cornerRadius"];
			// A dark tint keeps the panel's light text readable over a bright
			// desktop; the glass still bends and blurs what is behind it.
			[glass setValue:[NSColor colorWithWhite:0.06 alpha:0.55] forKey:@"tintColor"];
			return glass;
		}
	}
	NSVisualEffectView *blur = [[NSVisualEffectView alloc] initWithFrame:NSZeroRect];
	if (@available(macOS 10.14, *)) {
		blur.material = NSVisualEffectMaterialHUDWindow;
	} else {
		blur.material = NSVisualEffectMaterialDark;
	}
	blur.blendingMode = NSVisualEffectBlendingModeBehindWindow;
	blur.state = NSVisualEffectStateActive;
	blur.appearance = [NSAppearance appearanceNamed:NSAppearanceNameVibrantDark];
	blur.maskImage = GawkBottomRoundedMask(kGlassRadius);
	return blur;
}

// The glass at rest: the strip's size, under the notch.
- (NSRect)glassFrameCollapsed {
	NSRect bounds = self.content.bounds;
	CGFloat w = self.notchWidth + 2 * [self earWidth];
	CGFloat h = self.notchHeight + self.bandHeight;
	return NSMakeRect(round(NSMidX(bounds) - w / 2), NSMaxY(bounds) - h, w, h);
}

- (void)showGlass:(BOOL)show {
	NSUInteger gen = self.generation;
	if (show) {
		// The window has just grown: start at the strip and grow with the page.
		self.glass.frame = [self glassFrameCollapsed];
		self.glass.hidden = NO;
		[NSAnimationContext runAnimationGroup:^(NSAnimationContext *ctx) {
			ctx.duration = kGlassGrow;
			ctx.timingFunction = [CAMediaTimingFunction functionWithControlPoints:0.32 :1.0 :0.42 :1.0];
			self.glass.animator.frame = self.content.bounds;
		}];
		return;
	}
	[NSAnimationContext runAnimationGroup:^(NSAnimationContext *ctx) {
		ctx.duration = kCollapseDelay;
		ctx.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseIn];
		self.glass.animator.frame = [self glassFrameCollapsed];
	} completionHandler:^{
		// A newer expand superseded this collapse.
		if (gen == self.generation && !self.expanded) {
			self.glass.hidden = YES;
		}
	}];
}

#pragma mark Expand / collapse

- (void)tellPageExpanded:(BOOL)expanded {
	NSString *js = [NSString stringWithFormat:@"window.gawkNotch && window.gawkNotch.setExpanded(%@)",
		expanded ? @"true" : @"false"];
	[self.webView evaluateJavaScript:js completionHandler:nil];
}

- (void)applyExpanded:(BOOL)expanded animatePage:(BOOL)animate {
	self.expanded = expanded;
	NSUInteger gen = ++self.generation;
	if (expanded) {
		// Grow the window first so the page has room to animate open.
		self.content.coversAll = YES;
		[self.panel setFrame:[self frameExpanded:YES] display:YES];
		[self showGlass:YES];
		[self tellPageExpanded:YES];
		// Key, so one keystroke answers an agent. The panel is
		// non-activating: the app you were in stays the active app.
		[self.panel makeKeyWindow];
		[self startHoverPoll];
		[self startOutsideClickWatch];
		return;
	}
	[self stopHoverPoll];
	[self stopOutsideClickWatch];
	[self stopVoice];
	self.pinned = NO;
	self.content.coversAll = NO;
	[self showGlass:NO];
	[self tellPageExpanded:NO];
	if (self.panel.isKeyWindow) {
		// Hand the keyboard back to whatever app the human was in. Ordering a
		// key window out resigns it; resignKeyWindow must not be called directly.
		[self.panel orderOut:nil];
		[self.panel orderFrontRegardless];
	}
	self.keyboardActive = NO;
	self.peekUntil = nil;
	NSTimeInterval delay = animate ? kCollapseDelay : 0;
	dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
		// A newer expand/collapse superseded this one.
		if (gen != self.generation || self.expanded) {
			return;
		}
		[self.panel setFrame:[self frameExpanded:NO] display:YES];
	});
}

- (void)collapseUnlessBusy {
	if (self.hovering || self.keyboardActive || self.pinned) {
		return;
	}
	if (self.peekUntil != nil && [self.peekUntil timeIntervalSinceNow] > 0) {
		return;
	}
	[self applyExpanded:NO animatePage:YES];
}

- (void)startHoverPoll {
	if (self.hoverPoll != nil) {
		return;
	}
	__weak GawkNotchController *weakSelf = self;
	self.hoverPoll = [NSTimer scheduledTimerWithTimeInterval:kHoverPollInterval
	                                                 repeats:YES
	                                                   block:^(NSTimer *timer) {
		(void)timer;
		GawkNotchController *strongSelf = weakSelf;
		if (strongSelf == nil || !strongSelf.expanded) {
			return;
		}
		BOOL inside = NSPointInRect([NSEvent mouseLocation], strongSelf.panel.frame);
		strongSelf.hovering = inside;
		if (!inside) {
			[strongSelf collapseUnlessBusy];
		}
	}];
}

// A click outside the open panel closes it. The global monitor sees clicks
// in other apps (mouse events need no Accessibility permission); the local
// one sees clicks in this app's own windows, such as the full view.
- (void)startOutsideClickWatch {
	if (self.outsideClickGlobal != nil) {
		return;
	}
	__weak GawkNotchController *weakSelf = self;
	NSEventMask mask = NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown | NSEventMaskOtherMouseDown;
	void (^closeIfOutside)(void) = ^{
		GawkNotchController *strongSelf = weakSelf;
		if (strongSelf == nil || !strongSelf.expanded) {
			return;
		}
		if (NSPointInRect([NSEvent mouseLocation], strongSelf.panel.frame)) {
			return;
		}
		strongSelf.pinned = NO;
		strongSelf.hovering = NO;
		strongSelf.keyboardActive = NO;
		[strongSelf applyExpanded:NO animatePage:YES];
	};
	self.outsideClickGlobal = [NSEvent addGlobalMonitorForEventsMatchingMask:mask
	                                                                 handler:^(NSEvent *event) {
		(void)event;
		closeIfOutside();
	}];
	self.outsideClickLocal = [NSEvent addLocalMonitorForEventsMatchingMask:mask
	                                                               handler:^NSEvent *(NSEvent *event) {
		closeIfOutside();
		return event;
	}];
}

- (void)stopOutsideClickWatch {
	if (self.outsideClickGlobal != nil) {
		[NSEvent removeMonitor:self.outsideClickGlobal];
		self.outsideClickGlobal = nil;
	}
	if (self.outsideClickLocal != nil) {
		[NSEvent removeMonitor:self.outsideClickLocal];
		self.outsideClickLocal = nil;
	}
}

- (void)stopHoverPoll {
	[self.hoverPoll invalidate];
	self.hoverPoll = nil;
}

- (void)haptic:(NSHapticFeedbackPattern)pattern {
	// Felt only while a finger rests on a Force Touch trackpad, which is
	// exactly the hover case; elsewhere it is silently a no-op.
	[[NSHapticFeedbackManager defaultPerformer] performFeedbackPattern:pattern
	                                                   performanceTime:NSHapticFeedbackPerformanceTimeNow];
}

- (void)mouseEntered:(NSEvent *)event {
	(void)event;
	self.hovering = YES;
	if (!self.expanded) {
		[self haptic:NSHapticFeedbackPatternLevelChange];
		[self applyExpanded:YES animatePage:YES];
	}
}

- (void)mouseExited:(NSEvent *)event {
	(void)event;
	self.hovering = NO;
	NSUInteger gen = self.generation;
	dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kHoverExitGrace * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
		if (gen == self.generation) {
			[self collapseUnlessBusy];
		}
	});
}

// Something new needs the human: tap and peek the panel open, then fold it
// away again unless they moved onto it.
- (void)peek {
	[self haptic:NSHapticFeedbackPatternGeneric];
	if (self.expanded) {
		return;
	}
	[self applyExpanded:YES animatePage:YES];
	// The hover poll folds it away once this passes and the pointer is not on it.
	self.peekUntil = [NSDate dateWithTimeIntervalSinceNow:kPeekDuration];
}

#pragma mark Page → native

- (void)userContentController:(WKUserContentController *)controller
      didReceiveScriptMessage:(WKScriptMessage *)message {
	(void)controller;
	if (![message.body isKindOfClass:[NSDictionary class]]) {
		return;
	}
	// Only the notch page itself may drive the panel.
	if (!message.frameInfo.isMainFrame || ![self isOfficeURL:message.frameInfo.request.URL]) {
		return;
	}
	NSDictionary *body = message.body;
	NSString *type = [body[@"type"] isKindOfClass:[NSString class]] ? body[@"type"] : @"";

	if ([type isEqualToString:@"attention"]) {
		[self peek];
	} else if ([type isEqualToString:@"keyboard"]) {
		self.keyboardActive = [body[@"active"] boolValue];
		if (self.keyboardActive) {
			[self.panel makeKeyWindow];
		}
	} else if ([type isEqualToString:@"ears"]) {
		CGFloat w = [body[@"width"] respondsToSelector:@selector(doubleValue)] ? [body[@"width"] doubleValue] : 0;
		// Only the sizes the strip is drawn for.
		self.earsWidth = w > 0 ? kCompactEarWidth : 0;
		CGFloat band = [body[@"band"] respondsToSelector:@selector(doubleValue)] ? [body[@"band"] doubleValue] : 0;
		self.bandHeight = MAX(0, MIN(kMaxBandHeight, band));
		self.content.stripHeight = self.notchHeight + self.bandHeight;
		if (!self.expanded) {
			[self.panel setFrame:[self frameExpanded:NO] display:YES];
			[self.content updateTrackingAreas];
		}
	} else if ([type isEqualToString:@"stage"]) {
		CGFloat h = [body[@"height"] respondsToSelector:@selector(doubleValue)] ? [body[@"height"] doubleValue] : 0;
		self.stageHeight = MAX(0, MIN(kMaxStageHeight, h));
		if (!self.expanded) {
			[self.panel setFrame:[self frameExpanded:NO] display:YES];
		}
	} else if ([type isEqualToString:@"voice"]) {
		if ([body[@"action"] isEqual:@"start"]) {
			[self startVoice];
		} else {
			[self stopVoice];
		}
	} else if ([type isEqualToString:@"collapse"]) {
		self.pinned = NO;
		self.hovering = NO;
		self.keyboardActive = NO;
		[self applyExpanded:NO animatePage:YES];
	} else if ([type isEqualToString:@"open"]) {
		NSString *path = [body[@"path"] isKindOfClass:[NSString class]] ? body[@"path"] : @"";
		if ([path hasPrefix:@"/"] && ![path hasPrefix:@"//"]) {
			// Back in the Dock first, so the window comes up as a normal app
			// window rather than an accessory's.
			[self setDockVisible:YES];
			[NSApp activateIgnoringOtherApps:YES];
			goNotchOpen((char *)path.UTF8String);
		}
		self.hovering = NO;
		self.keyboardActive = NO;
		[self applyExpanded:NO animatePage:YES];
	}
}

#pragma mark Voice

// Whether macOS holds gawkbot itself responsible for what it asks of the
// privacy system. It does when gawkbot was opened as an app (Finder, the
// Dock, `open`). Run from a shell, the terminal app that started it is
// responsible instead, and macOS checks THAT app's usage strings: a terminal
// with no speech-recognition string (Superset has none) gets gawkbot killed
// on the spot, with no prompt and no crash report, the moment it asks for
// speech recognition. Unknown (the lookup is missing) counts as yes, which
// is how it behaved before this check.
static BOOL gawkOwnsItsPrivacyPrompts(void) {
	pid_t (*responsibleFor)(pid_t) =
		(pid_t (*)(pid_t))dlsym(RTLD_DEFAULT, "responsibility_get_pid_responsible_for_pid");
	if (responsibleFor == NULL) {
		return YES;
	}
	pid_t responsible = responsibleFor(getpid());
	return responsible <= 0 || responsible == getpid();
}

- (void)sendVoice:(NSString *)kind text:(NSString *)text message:(NSString *)message {
	NSMutableDictionary *event = [NSMutableDictionary dictionaryWithObject:kind forKey:@"kind"];
	if (text != nil) {
		event[@"text"] = text;
	}
	if (message != nil) {
		event[@"message"] = message;
	}
	NSData *json = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
	if (json == nil) {
		return;
	}
	NSString *arg = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
	NSString *js = [NSString stringWithFormat:@"window.gawkNotch && window.gawkNotch.voice && window.gawkNotch.voice(%@)", arg];
	[self.webView evaluateJavaScript:js completionHandler:nil];
}

- (void)voiceFailed:(NSString *)message {
	[self sendVoice:@"error" text:nil message:message];
	[self finishVoice];
}

// Asks for speech-recognition and microphone permission (macOS shows its own
// prompts the first time), then starts listening.
- (void)startVoice {
	if (self.voiceActive) {
		return;
	}
	self.voiceActive = YES;
	if (!gawkOwnsItsPrivacyPrompts()) {
		[self voiceFailed:@"Voice needs gawkbot opened as an app, from Finder, the Dock, or the open command. Started from a terminal, macOS asks that terminal for permission instead and stops gawkbot."];
		return;
	}
	if (@available(macOS 10.15, *)) {
		[SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
			dispatch_async(dispatch_get_main_queue(), ^{
				if (status != SFSpeechRecognizerAuthorizationStatusAuthorized) {
					[self voiceFailed:@"Speech recognition is off for gawkbot. Turn it on in System Settings, Privacy & Security."];
					return;
				}
				[AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
				                         completionHandler:^(BOOL granted) {
					dispatch_async(dispatch_get_main_queue(), ^{
						if (!granted) {
							[self voiceFailed:@"The microphone is off for gawkbot. Turn it on in System Settings, Privacy & Security."];
							return;
						}
						[self beginRecognition];
					});
				}];
			});
		}];
	} else {
		[self voiceFailed:@"Talking to agents needs macOS 10.15 or later."];
	}
}

- (void)beginRecognition {
	if (!self.voiceActive) {
		return; // released before permission came back
	}
	if (@available(macOS 10.15, *)) {
		[self beginRecognition1015];
	} else {
		[self voiceFailed:@"Talking to agents needs macOS 10.15 or later."];
	}
}

// Every Speech call is inside the @available check so this compiles warning
// free against the app's 10.13 deployment target.
- (void)beginRecognition1015 {
	if (@available(macOS 10.15, *)) {
		SFSpeechRecognizer *recognizer = self.speechRecognizer ?: [[SFSpeechRecognizer alloc] init];
		self.speechRecognizer = recognizer;
		if (recognizer == nil || !recognizer.isAvailable) {
			[self voiceFailed:@"Speech recognition is not available right now."];
			return;
		}
		SFSpeechAudioBufferRecognitionRequest *request = [[SFSpeechAudioBufferRecognitionRequest alloc] init];
		request.shouldReportPartialResults = YES;
		if (recognizer.supportsOnDeviceRecognition) {
			// Keep the human's voice on the Mac when the Mac can do it.
			request.requiresOnDeviceRecognition = YES;
		}
		self.speechRequest = request;

		self.audioEngine = [[AVAudioEngine alloc] init];
		AVAudioInputNode *input = self.audioEngine.inputNode;
		AVAudioFormat *format = [input outputFormatForBus:0];
		// With no usable input (none connected, or one switching, as AirPods
		// do) the format is 0 Hz or 0 channels, and installing a tap with it
		// throws an exception that would take the whole app down.
		if (format == nil || format.sampleRate <= 0 || format.channelCount == 0) {
			[self voiceFailed:@"No microphone is available. Check the input in System Settings, Sound."];
			return;
		}
		NSError *startError = nil;
		BOOL started = NO;
		@try {
			[input removeTapOnBus:0];
			[input installTapOnBus:0
			            bufferSize:1024
			                format:format
			                 block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
				(void)when;
				[request appendAudioPCMBuffer:buffer];
			}];
			[self.audioEngine prepare];
			started = [self.audioEngine startAndReturnError:&startError];
		} @catch (NSException *exception) {
			NSLog(@"gawkbot voice: the microphone would not start: %@", exception.reason);
			started = NO;
		}
		if (!started) {
			[self voiceFailed:@"Could not start the microphone."];
			return;
		}

		__weak GawkNotchController *weakSelf = self;
		self.speechTask = [recognizer recognitionTaskWithRequest:request
		                                           resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
			dispatch_async(dispatch_get_main_queue(), ^{
				GawkNotchController *strongSelf = weakSelf;
				if (strongSelf == nil || !strongSelf.voiceActive) {
					return;
				}
				if (result != nil) {
					[strongSelf sendVoice:(result.isFinal ? @"final" : @"partial")
					                 text:result.bestTranscription.formattedString
					              message:nil];
				}
				if (error != nil || result.isFinal) {
					[strongSelf finishVoice];
				}
			});
		}];
	}
}

// Key released: stop capturing; the recognizer then delivers its final text.
- (void)stopVoice {
	if (!self.voiceActive) {
		return;
	}
	if (self.audioEngine.isRunning) {
		[self.audioEngine stop];
		[self.audioEngine.inputNode removeTapOnBus:0];
	}
	if (@available(macOS 10.15, *)) {
		SFSpeechAudioBufferRecognitionRequest *request = self.speechRequest;
		[request endAudio];
		if (self.speechTask == nil) {
			[self finishVoice];
		}
	} else {
		[self finishVoice];
	}
}

- (void)finishVoice {
	if (!self.voiceActive) {
		return;
	}
	self.voiceActive = NO;
	if (self.audioEngine.isRunning) {
		[self.audioEngine stop];
		[self.audioEngine.inputNode removeTapOnBus:0];
	}
	self.audioEngine = nil;
	self.speechTask = nil;
	self.speechRequest = nil;
	[self sendVoice:@"end" text:nil message:nil];
}

#pragma mark Navigation

- (BOOL)isOfficeURL:(NSURL *)url {
	NSURL *office = [NSURL URLWithString:self.officeURL];
	return url != nil && office != nil &&
		[url.scheme isEqualToString:office.scheme] &&
		[url.host isEqualToString:office.host] &&
		((url.port == nil && office.port == nil) || [url.port isEqual:office.port]);
}

// The notch never leaves the office origin: anything else (a link in an
// agent's text, a redirect) is refused rather than loaded over the menu bar.
- (void)webView:(WKWebView *)webView
	decidePolicyForNavigationAction:(WKNavigationAction *)action
	                decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
	(void)webView;
	decisionHandler([self isOfficeURL:action.request.URL] ? WKNavigationActionPolicyAllow
	                                                      : WKNavigationActionPolicyCancel);
}

// The broker may still be booting when the app opens: retry until it answers.
- (void)retryLoadSoon {
	dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
		[self.webView loadRequest:[NSURLRequest requestWithURL:[self pageURL]]];
	});
}

- (void)webView:(WKWebView *)webView
	didFailProvisionalNavigation:(WKNavigation *)navigation
	                   withError:(NSError *)error {
	(void)webView;
	(void)navigation;
	if (error.code != NSURLErrorCancelled) {
		[self retryLoadSoon];
	}
}

- (void)webView:(WKWebView *)webView
	decidePolicyForNavigationResponse:(WKNavigationResponse *)response
	                  decisionHandler:(void (^)(WKNavigationResponsePolicy))decisionHandler {
	(void)webView;
	NSHTTPURLResponse *http = [response.response isKindOfClass:[NSHTTPURLResponse class]]
		? (NSHTTPURLResponse *)response.response
		: nil;
	if (response.isForMainFrame && http != nil && http.statusCode >= 400) {
		// e.g. 503 "web UI assets missing" while the broker warms up.
		decisionHandler(WKNavigationResponsePolicyCancel);
		[self retryLoadSoon];
		return;
	}
	decisionHandler(WKNavigationResponsePolicyAllow);
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
	(void)webView;
	[self retryLoadSoon];
}

@end

void GawkNotchStart(const char *officeURL) {
	NSString *url = [NSString stringWithUTF8String:officeURL ?: ""];
	dispatch_async(dispatch_get_main_queue(), ^{
		if (gNotch != nil || url.length == 0) {
			return;
		}
		gNotch = [[GawkNotchController alloc] init];
		gNotch.officeURL = url;
		[gNotch start];
	});
}
