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

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

#include "_cgo_export.h"

static const CGFloat kEarWidth = 72.0;
// Keep in sync with EXPANDED_WIDTH / EXPANDED_HEIGHT in web/src/notch/NotchView.tsx.
static const CGFloat kExpandedWidth = 440.0;
static const CGFloat kExpandedHeight = 420.0;
// Matches the .notch-shell CSS transition, so the panel shrinks only after
// the page has finished animating closed.
static const NSTimeInterval kCollapseDelay = 0.3;
static const NSTimeInterval kHoverExitGrace = 0.25;
static const NSTimeInterval kPeekDuration = 4.0;
// While open, the pointer is also polled: tracking-area exit events are not
// guaranteed when the area is rebuilt with the cursor already inside it (the
// panel grows under the pointer on every expand).
static const NSTimeInterval kHoverPollInterval = 0.2;

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
@end

// Hosts the web view and owns the hover tracking area.
@interface GawkNotchContentView : NSView
@property(nonatomic, weak) id hoverOwner;
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
	NSTrackingArea *area = [[NSTrackingArea alloc]
		initWithRect:NSZeroRect
		     options:NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways | NSTrackingInVisibleRect
		       owner:self.hoverOwner
		    userInfo:nil];
	[self addTrackingArea:area];
}
@end

@interface GawkNotchController : NSObject <WKScriptMessageHandler, WKNavigationDelegate>
@property(nonatomic, strong) GawkNotchPanel *panel;
@property(nonatomic, strong) GawkNotchContentView *content;
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic, copy) NSString *officeURL;
@property(nonatomic) CGFloat notchWidth;
@property(nonatomic) CGFloat notchHeight;
@property(nonatomic) BOOL expanded;
@property(nonatomic) BOOL hovering;
@property(nonatomic) BOOL keyboardActive;
@property(nonatomic) NSUInteger generation;
@property(nonatomic, strong) NSTimer *hoverPoll;
@property(nonatomic, strong) NSDate *peekUntil;
@end

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

- (NSRect)frameExpanded:(BOOL)expanded {
	NSScreen *screen = [self notchScreen];
	CGFloat collapsedWidth = self.notchWidth + 2 * kEarWidth;
	CGFloat w = expanded ? MAX(kExpandedWidth, collapsedWidth) : collapsedWidth;
	CGFloat h = expanded ? kExpandedHeight : self.notchHeight;
	NSRect sf = screen.frame;
	return NSMakeRect(round(NSMidX(sf) - w / 2), NSMaxY(sf) - h, w, h);
}

- (NSURL *)pageURL {
	NSString *base = [self.officeURL hasSuffix:@"/"]
		? [self.officeURL substringToIndex:self.officeURL.length - 1]
		: self.officeURL;
	NSString *s = [NSString stringWithFormat:@"%@/notch.html?nw=%.0f&nh=%.0f&ew=%.0f",
		base, self.notchWidth, self.notchHeight, kEarWidth];
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
	self.panel.level = NSStatusWindowLevel;
	self.panel.floatingPanel = YES;
	self.panel.hidesOnDeactivate = NO;
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

	self.content = [[GawkNotchContentView alloc] initWithFrame:NSMakeRect(0, 0, NSWidth(frame), NSHeight(frame))];
	self.content.autoresizesSubviews = YES;
	self.webView = [[WKWebView alloc] initWithFrame:self.content.bounds configuration:config];
	self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
	self.webView.navigationDelegate = self;
	// Transparent: only the page's black .notch-shell paints; the rest of
	// the panel shows the desktop through it.
	[self.webView setValue:@NO forKey:@"drawsBackground"];
	[self.content addSubview:self.webView];
	self.content.hoverOwner = self;
	self.panel.contentView = self.content;

	[[NSNotificationCenter defaultCenter] addObserver:self
	                                         selector:@selector(screensChanged:)
	                                             name:NSApplicationDidChangeScreenParametersNotification
	                                           object:nil];

	[self.webView loadRequest:[NSURLRequest requestWithURL:[self pageURL]]];
	[self.panel orderFrontRegardless];
}

- (void)screensChanged:(NSNotification *)note {
	(void)note;
	[self measure];
	[self applyExpanded:NO animatePage:NO];
	[self.webView loadRequest:[NSURLRequest requestWithURL:[self pageURL]]];
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
		[self.panel setFrame:[self frameExpanded:YES] display:YES];
		[self tellPageExpanded:YES];
		[self startHoverPoll];
		return;
	}
	[self stopHoverPoll];
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
	if (self.hovering || self.keyboardActive) {
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
	} else if ([type isEqualToString:@"collapse"]) {
		self.hovering = NO;
		self.keyboardActive = NO;
		[self applyExpanded:NO animatePage:YES];
	} else if ([type isEqualToString:@"open"]) {
		NSString *path = [body[@"path"] isKindOfClass:[NSString class]] ? body[@"path"] : @"";
		if ([path hasPrefix:@"/"] && ![path hasPrefix:@"//"]) {
			[NSApp activateIgnoringOtherApps:YES];
			goNotchOpen((char *)path.UTF8String);
		}
		self.hovering = NO;
		self.keyboardActive = NO;
		[self applyExpanded:NO animatePage:YES];
	}
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

static GawkNotchController *gNotch;

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
