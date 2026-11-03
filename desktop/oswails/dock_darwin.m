//go:build desktop && darwin && cgo

// The working-bot cards at the top right of the screen for the gawkbot Mac app.
//
// One small, transparent, non-activating NSPanel in the top-right corner of
// the notch's screen hosts a WKWebView of <office>/notch.html?dock=1
// (web/src/notch/NotchDock.tsx): one card per bot at work, with its face,
// what it is doing, and History / Open / Stop. The page sizes the panel
// ({type:"dock", height, count}); a count of zero hides it. It stays out
// of the way while the notch itself is open, and the notch's own "jump
// out" switch hides it too, which the page decides from the office state.
// Everything the cards show comes from the office over loopback HTTP; this
// file only floats the window and hands "open the full view" to Go.

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

#include "_cgo_export.h"

void GawkNotchShowAgent(const char *slug);

static const CGFloat kDockWidth = 300.0;
static const CGFloat kDockInset = 16.0;
static const CGFloat kDockMaxHeight = 600.0;
static const NSTimeInterval kDockRetry = 2.0;

@interface GawkDockPanel : NSPanel
@end

@implementation GawkDockPanel
- (BOOL)canBecomeKeyWindow {
	return NO;
}
- (BOOL)canBecomeMainWindow {
	return NO;
}
@end

@interface GawkDockController : NSObject <WKScriptMessageHandler, WKNavigationDelegate>
@property(nonatomic, strong) GawkDockPanel *panel;
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic, copy) NSString *officeURL;
@property(nonatomic) CGFloat height;
@property(nonatomic) NSInteger count;
// YES while the notch is open: the cards would sit under it.
@property(nonatomic) BOOL suppressed;
@end

static GawkDockController *gDock;

@implementation GawkDockController

- (NSScreen *)dockScreen {
	NSScreen *screen = [NSScreen mainScreen] ?: [NSScreen screens].firstObject;
	// The notch's screen is the built-in display; the cards follow it.
	for (NSScreen *s in [NSScreen screens]) {
		if (@available(macOS 12.0, *)) {
			if (s.safeAreaInsets.top > 0) {
				return s;
			}
		}
	}
	return screen;
}

- (NSRect)frameForHeight:(CGFloat)h {
	NSScreen *screen = [self dockScreen];
	NSRect vf = screen.visibleFrame;
	CGFloat height = MAX(1, MIN(kDockMaxHeight, h));
	CGFloat x = NSMaxX(vf) - kDockInset - kDockWidth;
	CGFloat y = NSMaxY(vf) - kDockInset - height;
	return NSMakeRect(round(x), round(y), kDockWidth, round(height));
}

- (NSURL *)pageURL {
	NSString *base = [self.officeURL hasSuffix:@"/"]
		? [self.officeURL substringToIndex:self.officeURL.length - 1]
		: self.officeURL;
	return [NSURL URLWithString:[NSString stringWithFormat:@"%@/notch.html?dock=1", base]];
}

- (void)start {
	NSRect frame = [self frameForHeight:1];
	self.panel = [[GawkDockPanel alloc]
		initWithContentRect:frame
		          styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
		            backing:NSBackingStoreBuffered
		              defer:NO];
	self.panel.opaque = NO;
	self.panel.backgroundColor = [NSColor clearColor];
	self.panel.hasShadow = NO;
	self.panel.floatingPanel = YES;
	// Above ordinary windows, below the notch (status level).
	self.panel.level = NSFloatingWindowLevel;
	self.panel.hidesOnDeactivate = NO;
	self.panel.canHide = NO;
	self.panel.movable = NO;
	self.panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
		NSWindowCollectionBehaviorStationary |
		NSWindowCollectionBehaviorFullScreenAuxiliary |
		NSWindowCollectionBehaviorIgnoresCycle;

	WKUserContentController *ucc = [[WKUserContentController alloc] init];
	[ucc addScriptMessageHandler:self name:@"gawkDock"];
	WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
	config.userContentController = ucc;
	self.webView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, NSWidth(frame), NSHeight(frame)) configuration:config];
	self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
	self.webView.navigationDelegate = self;
	[self.webView setValue:@NO forKey:@"drawsBackground"];
	self.panel.contentView = self.webView;

	[[NSNotificationCenter defaultCenter] addObserver:self
	                                         selector:@selector(screensChanged:)
	                                             name:NSApplicationDidChangeScreenParametersNotification
	                                           object:nil];
	[self.webView loadRequest:[NSURLRequest requestWithURL:[self pageURL]]];
}

- (void)apply {
	BOOL show = self.count > 0 && self.height > 0 && !self.suppressed;
	if (!show) {
		[self.panel orderOut:nil];
		return;
	}
	[self.panel setFrame:[self frameForHeight:self.height] display:YES];
	[self.panel orderFrontRegardless];
}

- (void)screensChanged:(NSNotification *)note {
	(void)note;
	[self apply];
}

- (void)userContentController:(WKUserContentController *)controller
      didReceiveScriptMessage:(WKScriptMessage *)message {
	(void)controller;
	NSDictionary *body = [message.body isKindOfClass:[NSDictionary class]] ? message.body : @{};
	NSString *type = [body[@"type"] isKindOfClass:[NSString class]] ? body[@"type"] : @"";
	if ([type isEqualToString:@"dock"]) {
		CGFloat h = [body[@"height"] respondsToSelector:@selector(doubleValue)] ? [body[@"height"] doubleValue] : 0;
		NSInteger n = [body[@"count"] respondsToSelector:@selector(integerValue)] ? [body[@"count"] integerValue] : 0;
		self.height = MAX(0, h);
		self.count = MAX(0, n);
		[self apply];
	} else if ([type isEqualToString:@"chat"]) {
		NSString *slug = [body[@"slug"] isKindOfClass:[NSString class]] ? body[@"slug"] : @"";
		NSCharacterSet *bad = [[NSCharacterSet characterSetWithCharactersInString:
			@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_."] invertedSet];
		if (slug.length > 0 && slug.length <= 128 && [slug rangeOfCharacterFromSet:bad].location == NSNotFound) {
			GawkNotchShowAgent(slug.UTF8String);
		}
	} else if ([type isEqualToString:@"open"]) {
		NSString *path = [body[@"path"] isKindOfClass:[NSString class]] ? body[@"path"] : @"";
		if ([path hasPrefix:@"/"] && ![path hasPrefix:@"//"]) {
			[NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
			[NSApp activateIgnoringOtherApps:YES];
			goNotchOpen((char *)path.UTF8String);
		}
	}
}

- (void)retryLoadSoon {
	__weak GawkDockController *weakSelf = self;
	dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kDockRetry * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
		GawkDockController *strongSelf = weakSelf;
		if (strongSelf != nil) {
			[strongSelf.webView loadRequest:[NSURLRequest requestWithURL:[strongSelf pageURL]]];
		}
	});
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
	(void)webView;
	(void)navigation;
	(void)error;
	[self retryLoadSoon];
}

- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
	(void)webView;
	(void)navigation;
	(void)error;
	[self retryLoadSoon];
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
	(void)webView;
	[self retryLoadSoon];
}

@end

void GawkDockStart(const char *officeURL) {
	NSString *url = [NSString stringWithUTF8String:officeURL ?: ""];
	dispatch_async(dispatch_get_main_queue(), ^{
		if (gDock != nil || url.length == 0) {
			return;
		}
		gDock = [[GawkDockController alloc] init];
		gDock.officeURL = url;
		[gDock start];
	});
}

// GawkDockSuppress hides the cards while the notch is open and shows them
// again when it closes.
void GawkDockSuppress(int suppressed) {
	dispatch_async(dispatch_get_main_queue(), ^{
		if (gDock == nil) {
			return;
		}
		gDock.suppressed = suppressed != 0;
		[gDock apply];
	});
}
