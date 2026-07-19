---
slug: let-your-agent-draw-the-architecture
title: Let your coding agent draw the architecture
description: Point a coding agent at a system — your own codebase or one it researches, like Kubernetes — and it draws the architecture as live diagrams right in the document.
date: 2026-07-19
author: Sam Goldstein
---

The fastest way to understand a system is to see it. A paragraph describing how requests move through four subsystems takes a minute to read and a while longer to hold in your head. The same thing as a diagram lands in a second.

Your coding agent can draw that diagram for you. Point it at a codebase, or ask it to research something it has never seen, and it renders the architecture as diagrams — live, in the document, redrawing them as you talk. Here is what that looks like.

## Ask it to research a system and draw it

I gave an agent a prompt with none of my own code in scope: "Can you research k8s and draw me a set of technical diagrams that illustrate how it works." It came back with a small reference — four views of Kubernetes, each a diagram and a short explanation.

### The cluster, end to end

```mermaid
graph TB
    subgraph CP["Control Plane (usually 3+ nodes for HA)"]
        API["kube-apiserver"]
        ETCD[("etcd\n(cluster state store)")]
        SCHED["kube-scheduler"]
        CM["kube-controller-manager"]
        CCM["cloud-controller-manager\n(optional)"]
    end

    subgraph N1["Worker Node"]
        KUBELET1["kubelet"]
        PROXY1["kube-proxy"]
        CRI1["container runtime\n(containerd/CRI-O)"]
        PODS1["Pods"]
    end

    subgraph N2["Worker Node"]
        KUBELET2["kubelet"]
        PROXY2["kube-proxy"]
        CRI2["container runtime"]
        PODS2["Pods"]
    end

    CLOUD["Cloud provider API\n(AWS/GCP/Azure...)"]

    USER["User / CI/CD\n(kubectl, API clients)"] -->|"REST/HTTPS"| API
    API <--> ETCD
    SCHED -->|"watch/assign"| API
    CM -->|"watch/reconcile"| API
    CCM -->|"watch/reconcile"| API
    CCM -->|"cloud API calls"| CLOUD
    API <-->|"watch/report status"| KUBELET1
    API <-->|"watch/report status"| KUBELET2
    PROXY1 -->|"watch Services/\nEndpointSlices"| API
    PROXY2 -->|"watch Services/\nEndpointSlices"| API
    KUBELET1 --> CRI1
    CRI1 --> PODS1
    KUBELET2 --> CRI2
    CRI2 --> PODS2
    PROXY1 -.->|"programs node kernel rules\n(iptables/IPVS) routing to"| PODS1
    PROXY2 -.->|"programs node kernel rules\n(iptables/IPVS)"| PODS2
```

A cluster splits into two halves. The control plane makes the decisions — it stores state, schedules pods, and runs the controllers that reconcile actual state toward what you asked for. The worker nodes run the workloads. Everything in and out of the control plane goes through the API server; nothing else, not even the scheduler or the controller manager, talks to etcd directly.

### What happens when you run `kubectl apply`

```mermaid
sequenceDiagram
    participant U as User (kubectl apply)
    participant API as kube-apiserver
    participant ETCD as etcd
    participant SCHED as kube-scheduler
    participant CM as controller-manager
    participant KUBELET as kubelet (chosen node)
    participant CRI as container runtime

    U->>API: POST Pod spec
    API->>API: authenticate, authorize, admission checks
    API->>ETCD: write Pod object (unscheduled)
    API-->>U: 201 Created

    SCHED->>API: watch for unscheduled Pods
    SCHED->>SCHED: filter + score nodes
    SCHED->>API: bind Pod to Node X
    API->>ETCD: update Pod (nodeName set)

    KUBELET->>API: watch for Pods assigned to this node
    KUBELET->>CRI: create containers per PodSpec
    CRI-->>KUBELET: containers running
    KUBELET->>API: report Pod status = Running
    API->>ETCD: update Pod status

    CM->>API: watch (e.g. Deployment controller)
    CM->>CM: reconcile: actual replicas == desired?
```

The API server validates the object and writes it to etcd immediately, before anything runs — it does not schedule the pod itself. The scheduler is a separate watcher that notices unscheduled pods, picks a node, and writes the assignment back. The kubelet on that node is what actually tells the container runtime to start containers, then reports status. Controllers run this same watch-and-correct loop continuously.

### How traffic reaches a pod

```mermaid
graph LR
    CLIENT["External client"] -->|"1. request"| LB["Cloud Load Balancer\n(Service type: LoadBalancer)"]
    LB -->|"2. forwards to\na NodePort"| KERNA["Node A kernel\n(iptables/IPVS rules)"]
    LB -->|"2. forwards to\na NodePort"| KERNB["Node B kernel\n(iptables/IPVS rules)"]
    KERNA -->|"3. DNAT to a\nready pod IP"| PODA["Pod (app container)\nNode A"]
    KERNA -->|"3. DNAT to a\nready pod IP"| PODC["Pod (app container)\nNode C"]
    KERNB -->|"3. DNAT to a\nready pod IP"| PODB["Pod (app container)\nNode B"]

    API["kube-apiserver\nService (ClusterIP) +\nEndpointSlice (ready pod IPs)"]
    KP["kube-proxy\n(one per node — programs rules,\nnever touches packets)"]
    KP -->|"watch Services +\nEndpointSlices"| API
    KP -.->|"programs\nkernel rules"| KERNA
    KP -.->|"programs\nkernel rules"| KERNB

    PODA -.->|"in-cluster clients resolve\nmy-svc.ns.svc via CoreDNS\nto the ClusterIP (virtual —\nexists only in kernel rules)"| DNS["CoreDNS"]
```

A Service is a stable virtual IP and DNS name for a set of pods that come and go as they scale or restart. kube-proxy on every node watches the live list of healthy pods and programs the node's iptables or IPVS rules — but it never touches packets itself; once the rules are in place, the kernel does the redirection. CoreDNS resolves the friendly Service name to that virtual IP.

### Why controllers all work the same way

```mermaid
stateDiagram-v2
    [*] --> Observe
    Observe: Watch API server for object changes
    Compare: Compare desired state (spec) vs actual observed cluster state
    Act: Issue API calls to close the gap\n(create/delete/update objects)
    Wait: Sleep or block on next watch event

    Observe --> Compare
    Compare --> Act: states differ
    Compare --> Wait: states match
    Act --> Observe
    Wait --> Observe
```

This loop is the single pattern behind every controller in Kubernetes, from the built-in Deployment controller to custom operators: watch the objects you manage, compare desired state to what actually exists, issue API calls to close the gap, repeat forever. It is what makes the system self-healing — if a pod dies, the gap reappears on the next pass and the controller acts again, with no separate recovery code.

## The part worth noticing

None of that is my code. The agent researched Kubernetes and drew it, and it got the details right: only the API server talks to etcd, the scheduler and kubelet are separate watchers rather than one pipeline, kube-proxy programs rules instead of forwarding packets. It also reached for the right kind of diagram for each idea — a flowchart for structure, a sequence diagram for the scheduling flow, a state diagram for the loop.

The diagrams are Mermaid: a few lines of code the agent writes, so they render live in the document as it works, sit next to the prose that explains them, and stay editable. The next time you open the document the agent can read the diagram it drew and change it, and the same fenced block renders on GitHub when the doc syncs to your repo. (For the times you need exact control over a drawing, an SVG block takes raw SVG, sanitized on render.)

## Try it on your own project

I do this all the time when I am exploring or building something — reading my way into an unfamiliar codebase, sketching a design before I write it, or explaining a subsystem to someone about to work in it. The picture is faster to produce than a paragraph and faster to understand.

You can ask Claude Code to do the same thing in your repo: point it at the code and ask for the picture, then talk to it until the picture is right. You will understand your own architecture faster, and so will everyone you show it to.
