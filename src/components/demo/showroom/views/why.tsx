"use client";

import * as React from "react";
import { useShowroom } from "@/components/demo/showroom/context";
import { ConversionPanel } from "@/components/demo/showroom/cta";
import { WhyContent } from "@/components/demo/showroom/why-content";

/** "Why iAcquireOS?" inside the room: the shared content, ending in the two requests. It stays open after the interactive window ends. */
export function WhyView() {
  const { setupFeeUsd, monthlyPlanUsd } = useShowroom();
  return <WhyContent setupFeeUsd={setupFeeUsd} monthlyPlanUsd={monthlyPlanUsd} actions={<ConversionPanel title="Ready to talk about your business?" />} />;
}
