//go:build desktop && darwin && cgo

// Drawing on the person's screen for the gawkbot Mac app.
//
// One transparent, click-through window per display, above every app and
// its menus, that paints a scene: pointers, labels, arrows, circles and
// boxes, each in global screen points with the origin at the top-left of
// the main display (what the computer-use driver reports). Nothing here
// takes input, focus, or a screenshot; it only draws, and fades when the
// scene's time is up. The scene arrives as JSON from Go
// (internal/hostcomputer/scene.go is the contract).

#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>

static const CGFloat kOverlayFadeSeconds = 0.35;

// A harness built with -DGAWK_OVERLAY_TRACE prints the lifecycle; the app
// build prints nothing.
#ifdef GAWK_OVERLAY_TRACE
#define overlayTrace(...) fprintf(stderr, "overlay: " __VA_ARGS__)
#else
#define overlayTrace(...) ((void)0)
#endif
static const CGFloat kLabelFont = 12.0;
static const CGFloat kLabelPadX = 8.0;
static const CGFloat kLabelPadY = 4.0;
static const CGFloat kLabelRadius = 7.0;
static const CGFloat kStroke = 2.5;
static const CGFloat kPointerSize = 18.0;

@interface GawkOverlayWindow : NSWindow
@end

@implementation GawkOverlayWindow
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
// The whole display, menu bar included: a pointer may land on a menu item.
- (NSRect)constrainFrameRect:(NSRect)frameRect toScreen:(NSScreen *)screen {
	(void)screen;
	return frameRect;
}
@end

@interface GawkOverlayView : NSView
@property (nonatomic, strong) CALayer *scene;
@end

@implementation GawkOverlayView
- (BOOL)isFlipped { return YES; }
- (NSView *)hitTest:(NSPoint)point { (void)point; return nil; }
@end

@interface GawkOverlay : NSObject
@property (nonatomic, strong) NSMutableArray<GawkOverlayWindow *> *windows;
@property (nonatomic, strong) NSString *sceneID;
@property (nonatomic, strong) NSTimer *fade;
@end

static GawkOverlay *gOverlay;

static NSColor *overlayColor(id hex, NSColor *fallback) {
	if (![hex isKindOfClass:[NSString class]]) {
		return fallback;
	}
	NSString *s = [(NSString *)hex stringByReplacingOccurrencesOfString:@"#" withString:@""];
	if (s.length != 6) {
		return fallback;
	}
	unsigned int v = 0;
	if (![[NSScanner scannerWithString:s] scanHexInt:&v]) {
		return fallback;
	}
	return [NSColor colorWithSRGBRed:((v >> 16) & 0xff) / 255.0
	                           green:((v >> 8) & 0xff) / 255.0
	                            blue:(v & 0xff) / 255.0
	                           alpha:1.0];
}

static CGFloat num(NSDictionary *d, NSString *key, CGFloat fallback) {
	id v = d[key];
	return [v respondsToSelector:@selector(doubleValue)] ? [v doubleValue] : fallback;
}

static BOOL reduceMotion(void) {
	return [[NSWorkspace sharedWorkspace] accessibilityDisplayShouldReduceMotion];
}

@implementation GawkOverlay

- (instancetype)init {
	if ((self = [super init])) {
		_windows = [NSMutableArray array];
	}
	return self;
}

// Global screen points, top-left origin on the main display (the driver's
// space), to AppKit's bottom-left global space.
- (NSPoint)appKitPoint:(CGPoint)p {
	NSScreen *main = [NSScreen screens].firstObject;
	CGFloat h = NSMaxY(main.frame);
	return NSMakePoint(p.x, h - p.y);
}

// One window per display, covering it exactly, created on first use and
// re-made when displays change.
- (void)ensureWindows {
	NSArray<NSScreen *> *screens = [NSScreen screens];
	if (self.windows.count == screens.count) {
		BOOL same = YES;
		for (NSUInteger i = 0; i < screens.count; i++) {
			if (!NSEqualRects(self.windows[i].frame, screens[i].frame)) {
				same = NO;
				break;
			}
		}
		if (same) {
			return;
		}
	}
	for (GawkOverlayWindow *w in self.windows) {
		[w orderOut:nil];
	}
	[self.windows removeAllObjects];
	for (NSScreen *screen in screens) {
		GawkOverlayWindow *w = [[GawkOverlayWindow alloc] initWithContentRect:screen.frame
		                                                            styleMask:NSWindowStyleMaskBorderless
		                                                              backing:NSBackingStoreBuffered
		                                                                defer:NO];
		w.opaque = NO;
		w.backgroundColor = [NSColor clearColor];
		w.hasShadow = NO;
		w.ignoresMouseEvents = YES;
		w.canHide = NO;
		w.releasedWhenClosed = NO;
		// Above menus and popups, so a pointer at a menu item shows.
		w.level = NSPopUpMenuWindowLevel + 1;
		w.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
			NSWindowCollectionBehaviorStationary |
			NSWindowCollectionBehaviorFullScreenAuxiliary |
			NSWindowCollectionBehaviorIgnoresCycle;
		GawkOverlayView *view = [[GawkOverlayView alloc] initWithFrame:NSMakeRect(0, 0, NSWidth(screen.frame), NSHeight(screen.frame))];
		view.wantsLayer = YES;
		view.layer.backgroundColor = [NSColor clearColor].CGColor;
		w.contentView = view;
		overlayTrace("window %ld for screen %gx%g at %g,%g\n", (long)w.windowNumber, NSWidth(screen.frame), NSHeight(screen.frame), NSMinX(screen.frame), NSMinY(screen.frame));
		[self.windows addObject:w];
	}
}

- (CATextLayer *)labelLayer:(NSString *)text at:(CGPoint)anchor color:(NSColor *)color {
	NSFont *font = [NSFont systemFontOfSize:kLabelFont weight:NSFontWeightSemibold];
	NSDictionary *attrs = @{NSFontAttributeName : font};
	NSSize size = [text sizeWithAttributes:attrs];
	CATextLayer *layer = [CATextLayer layer];
	layer.string = text;
	layer.font = (__bridge CFTypeRef)font;
	layer.fontSize = kLabelFont;
	layer.foregroundColor = [NSColor whiteColor].CGColor;
	layer.backgroundColor = color.CGColor;
	layer.cornerRadius = kLabelRadius;
	layer.alignmentMode = kCAAlignmentCenter;
	layer.contentsScale = [NSScreen mainScreen].backingScaleFactor;
	layer.truncationMode = kCATruncationEnd;
	CGFloat w = ceil(size.width) + 2 * kLabelPadX;
	CGFloat h = ceil(size.height) + 2 * kLabelPadY;
	// Vertically centre the text inside the pill (CATextLayer draws from the top).
	layer.frame = CGRectMake(anchor.x, anchor.y, w, h);
	CATextLayer *inner = layer;
	inner.bounds = CGRectMake(0, 0, w, h);
	inner.position = CGPointMake(anchor.x + w / 2, anchor.y + h / 2);
	CGFloat textTop = (h - ceil(size.height)) / 2;
	inner.contentsRect = CGRectMake(0, 0, 1, 1);
	inner.sublayerTransform = CATransform3DMakeTranslation(0, textTop, 0);
	return layer;
}

- (CAShapeLayer *)strokeLayer:(CGPathRef)path color:(NSColor *)color fill:(BOOL)fill {
	CAShapeLayer *layer = [CAShapeLayer layer];
	layer.path = path;
	layer.strokeColor = color.CGColor;
	layer.fillColor = fill ? color.CGColor : [NSColor clearColor].CGColor;
	layer.lineWidth = kStroke;
	layer.lineCap = kCALineCapRound;
	layer.lineJoin = kCALineJoinRound;
	return layer;
}

// Converts a global top-left rect into the view's flipped coordinates for
// one window (the view is flipped, so y grows downward like the driver's).
- (CGRect)viewRect:(NSDictionary *)r inWindow:(NSWindow *)w {
	CGFloat x = num(r, @"x", 0), y = num(r, @"y", 0), wd = num(r, @"w", 0), ht = num(r, @"h", 0);
	NSPoint top = [self appKitPoint:CGPointMake(x, y)];
	NSPoint local = NSMakePoint(top.x - NSMinX(w.frame), NSMaxY(w.frame) - top.y);
	return CGRectMake(local.x, local.y, wd, ht);
}

- (CGPoint)viewPoint:(CGFloat)x y:(CGFloat)y inWindow:(NSWindow *)w {
	NSPoint top = [self appKitPoint:CGPointMake(x, y)];
	return CGPointMake(top.x - NSMinX(w.frame), NSMaxY(w.frame) - top.y);
}

- (void)addItem:(NSDictionary *)item toLayer:(CALayer *)scene inWindow:(NSWindow *)w accent:(NSColor *)accent {
	NSString *kind = [item[@"kind"] isKindOfClass:[NSString class]] ? item[@"kind"] : @"";
	NSColor *color = overlayColor(item[@"color"], accent);
	NSString *label = [item[@"label"] isKindOfClass:[NSString class]] ? item[@"label"] : nil;
	if ([kind isEqualToString:@"pointer"]) {
		CGPoint tip = [self viewPoint:num(item, @"x", 0) y:num(item, @"y", 0) inWindow:w];
		CGMutablePathRef path = CGPathCreateMutable();
		CGPathMoveToPoint(path, NULL, tip.x, tip.y);
		CGPathAddLineToPoint(path, NULL, tip.x + kPointerSize * 0.95, tip.y + kPointerSize * 0.55);
		CGPathAddLineToPoint(path, NULL, tip.x + kPointerSize * 0.55, tip.y + kPointerSize * 0.95);
		CGPathCloseSubpath(path);
		CAShapeLayer *arrow = [self strokeLayer:path color:color fill:YES];
		arrow.strokeColor = [NSColor whiteColor].CGColor;
		arrow.lineWidth = 1.5;
		CGPathRelease(path);
		[scene addSublayer:arrow];
		if (label.length > 0) {
			[scene addSublayer:[self labelLayer:label at:CGPointMake(tip.x + kPointerSize + 6, tip.y + 2) color:color]];
		}
	} else if ([kind isEqualToString:@"label"]) {
		NSString *text = [item[@"text"] isKindOfClass:[NSString class]] ? item[@"text"] : @"";
		if (text.length > 0) {
			CGPoint at = [self viewPoint:num(item, @"x", 0) y:num(item, @"y", 0) inWindow:w];
			[scene addSublayer:[self labelLayer:text at:at color:color]];
		}
	} else if ([kind isEqualToString:@"arrow"]) {
		NSDictionary *from = [item[@"from"] isKindOfClass:[NSDictionary class]] ? item[@"from"] : nil;
		NSDictionary *to = [item[@"to"] isKindOfClass:[NSDictionary class]] ? item[@"to"] : nil;
		if (from == nil || to == nil) {
			return;
		}
		CGRect a = [self viewRect:from inWindow:w], b = [self viewRect:to inWindow:w];
		CGPoint p0 = CGPointMake(CGRectGetMidX(a), CGRectGetMidY(a));
		CGPoint p1 = CGPointMake(CGRectGetMidX(b), CGRectGetMidY(b));
		// Start and end just outside each rect, along the line between centres.
		CGFloat dx = p1.x - p0.x, dy = p1.y - p0.y, len = MAX(1, hypot(dx, dy));
		CGFloat ux = dx / len, uy = dy / len;
		CGFloat ra = MIN(CGRectGetWidth(a), CGRectGetHeight(a)) / 2, rb = MIN(CGRectGetWidth(b), CGRectGetHeight(b)) / 2;
		CGPoint s = CGPointMake(p0.x + ux * ra, p0.y + uy * ra);
		CGPoint e = CGPointMake(p1.x - ux * (rb + 4), p1.y - uy * (rb + 4));
		CGMutablePathRef path = CGPathCreateMutable();
		CGPathMoveToPoint(path, NULL, s.x, s.y);
		// A gentle curve reads as drawn by hand, not plotted.
		CGPoint ctrl = CGPointMake((s.x + e.x) / 2 - uy * len * 0.18, (s.y + e.y) / 2 + ux * len * 0.18);
		CGPathAddQuadCurveToPoint(path, NULL, ctrl.x, ctrl.y, e.x, e.y);
		CGFloat hx = e.x - ctrl.x, hy = e.y - ctrl.y, hl = MAX(1, hypot(hx, hy));
		hx /= hl; hy /= hl;
		CGFloat head = 12;
		CGPathMoveToPoint(path, NULL, e.x - head * (hx * 0.87 - hy * 0.5), e.y - head * (hy * 0.87 + hx * 0.5));
		CGPathAddLineToPoint(path, NULL, e.x, e.y);
		CGPathAddLineToPoint(path, NULL, e.x - head * (hx * 0.87 + hy * 0.5), e.y - head * (hy * 0.87 - hx * 0.5));
		[scene addSublayer:[self strokeLayer:path color:color fill:NO]];
		CGPathRelease(path);
		if (label.length > 0) {
			[scene addSublayer:[self labelLayer:label at:CGPointMake(ctrl.x + 6, ctrl.y - 22) color:color]];
		}
	} else if ([kind isEqualToString:@"circle"] || [kind isEqualToString:@"box"]) {
		NSDictionary *rd = [item[@"rect"] isKindOfClass:[NSDictionary class]] ? item[@"rect"] : nil;
		if (rd == nil) {
			return;
		}
		CGRect r = CGRectInset([self viewRect:rd inWindow:w], -6, -6);
		CGPathRef path = [kind isEqualToString:@"circle"]
			? CGPathCreateWithEllipseInRect(r, NULL)
			: CGPathCreateWithRoundedRect(r, 8, 8, NULL);
		[scene addSublayer:[self strokeLayer:path color:color fill:NO]];
		CGPathRelease(path);
		if (label.length > 0) {
			[scene addSublayer:[self labelLayer:label at:CGPointMake(CGRectGetMinX(r), CGRectGetMaxY(r) + 6) color:color]];
		}
	}
}

- (void)clear {
	overlayTrace("clear (%lu windows)\n", (unsigned long)self.windows.count);
	[self.fade invalidate];
	self.fade = nil;
	self.sceneID = nil;
	for (GawkOverlayWindow *w in self.windows) {
		GawkOverlayView *view = (GawkOverlayView *)w.contentView;
		[view.scene removeFromSuperlayer];
		view.scene = nil;
		[w orderOut:nil];
		overlayTrace("ordered out window %ld: visible=%d occlusion=%lu\n", (long)w.windowNumber, w.isVisible, (unsigned long)w.occlusionState);
	}
}

- (void)fadeOut {
	overlayTrace("fade out\n");
	self.fade = nil;
	if (reduceMotion()) {
		[self clear];
		return;
	}
	for (GawkOverlayWindow *w in self.windows) {
		GawkOverlayView *view = (GawkOverlayView *)w.contentView;
		[CATransaction begin];
		[CATransaction setAnimationDuration:kOverlayFadeSeconds];
		view.scene.opacity = 0;
		[CATransaction commit];
	}
	[NSTimer scheduledTimerWithTimeInterval:kOverlayFadeSeconds repeats:NO block:^(NSTimer *t) {
		(void)t;
		[self clear];
	}];
}

- (void)show:(NSDictionary *)scene {
	overlayTrace("show %s\n", [[scene[@"id"] ?: @"" description] UTF8String]);
	[self clear];
	[self ensureWindows];
	NSArray *items = [scene[@"items"] isKindOfClass:[NSArray class]] ? scene[@"items"] : @[];
	NSColor *accent = overlayColor(scene[@"color"], [NSColor colorWithSRGBRed:0.35 green:0.66 blue:1.0 alpha:1.0]);
	self.sceneID = [scene[@"id"] isKindOfClass:[NSString class]] ? scene[@"id"] : @"";
	BOOL still = reduceMotion();
	for (GawkOverlayWindow *w in self.windows) {
		GawkOverlayView *view = (GawkOverlayView *)w.contentView;
		CALayer *layer = [CALayer layer];
		layer.frame = view.bounds;
		for (id item in items) {
			if ([item isKindOfClass:[NSDictionary class]]) {
				[self addItem:item toLayer:layer inWindow:w accent:accent];
			}
		}
		if (layer.sublayers.count == 0) {
			continue;
		}
		view.scene = layer;
		[view.layer addSublayer:layer];
		if (!still) {
			CABasicAnimation *in = [CABasicAnimation animationWithKeyPath:@"opacity"];
			in.fromValue = @0;
			in.toValue = @1;
			in.duration = 0.18;
			[layer addAnimation:in forKey:@"in"];
		}
		[w orderFrontRegardless];
	}
	CGFloat ttl = num(scene, @"ttl_ms", 0) / 1000.0;
	overlayTrace("shown on %lu window(s), ttl %.2fs\n", (unsigned long)self.windows.count, ttl);
	if (ttl > 0) {
		self.fade = [NSTimer scheduledTimerWithTimeInterval:ttl repeats:NO block:^(NSTimer *t) {
			(void)t;
			[self fadeOut];
		}];
	}
}

@end

#pragma mark C exports

// GawkOverlaySetScene draws a scene (JSON, see internal/hostcomputer/scene.go).
void GawkOverlaySetScene(const char *json) {
	NSData *data = [NSData dataWithBytes:json length:strlen(json)];
	id scene = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
	if (![scene isKindOfClass:[NSDictionary class]]) {
		return;
	}
	dispatch_async(dispatch_get_main_queue(), ^{
		if (gOverlay == nil) {
			gOverlay = [[GawkOverlay alloc] init];
		}
		[gOverlay show:scene];
	});
}

// GawkOverlayClear removes whatever is drawn.
void GawkOverlayClear(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		[gOverlay clear];
	});
}
