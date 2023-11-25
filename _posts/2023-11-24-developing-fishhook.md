---
layout: post
title:  "Developing fishhook"
categories: Python
---

[Fishhook](https://pypi.org/project/fishhook/) was one of my first major low level Python projects. 
I set out with the goal to make an easy to use, dynamic Python dunder hooking tool, similar to [forbiddenfruit](https://pypi.org/project/forbiddenfruit/). However, I wanted to improve on the methods used in forbiddenfruit, where many of the offsets and details were hard coded. 

*Disclaimer: This post goes into a lot of internal details about how CPython (the reference implementation of Python) works. I recommend reading the CPython C documentation and chunks of referred to source code for clarity*

## Background

Dunder methods in Python are implemented as function pointers located on the type instance. Some are located on the base instance, and some are located on substructures pointed to by the base instance. Some of the functions on the main instance are `type->tp_call` and `type->tp_iter`, while things like `tp_add` are located on `type->tp_as_number->tp_add`. In order for my hooking strategy to be nicely dynamic, I wanted to calculate as many offsets and memory locations at runtime based off of attributes that would change with updates. Moving forward, this enabled fishhook to work on multiple versions without major code changes, and also allowed fishhook to work with *no* changes when Python 3.10 released.

In order to replace a C implemented dunder with a Python implementation, the given `tp_*` function would need to be replaced with one that called the Python implementation. Also, for ease of use, a strategy for calling the original implementation needed to be provided.

All versions of fishhook provided the same basic `hook` and `orig` functions to provide this functionality, but the underlying implementation changed dramatically.

## Major Version 1

While I was building fishhook, I went through a few strategies for calculating dunder function pointer locations. In reviewing various objects available in the Python interpreter, the first method I used involved some behavior of the `wrapper_descriptor` class. When dunders for C types are accessed directly, like `int.__add__`, the interpreter creates and returns an instance of `wrapper_descriptor` configured as a `slot wrapper`.

`wrapper_descriptor` instances are layed out as follows:
```c
// cpython/blob/main/Include/cpython/descrobject.h
struct wrapperbase {
    const char *name;
    int offset;
    void *function;
    wrapperfunc wrapper;
    const char *doc;
    int flags;
    PyObject *name_strobj;
};

typedef struct {
    PyDescr_COMMON;
    struct wrapperbase *d_base;
    void *d_wrapped;
} PyWrapperDescrObject;
```

This layout yields a property `instance->d_base.offset` which details the offset from the beginning of a given `tp_as_type` dunder methods structure. This did not give me a way of knowing where the different `tp_as_type` structures were, but I could at least generate the function mapping into those structures at runtime.

The way I generated this mapping was not clean. I looped over every subclass in `object.__subclasses__()`, and looked for dunders. Then I checked if they were instances of `wrapper_descriptor`, and pulled out the offsets and the name of a given dunder. Now, the interesting thing about `d_base.offset` is that it is actually the offset of a given dunder on a `PyHeapTypeObject`, not a `PyTypeObject`. The objects are similar, with one key difference, in `PyHeapTypeObject`s, the `tp_as_type` structures are layed out directly after the `PyTypeObject` data. This means, given the offsets from the `wrapperbase`, you could determine where exactly a slot pointer for a given dunder needed to be placed.

I used this to generate a `slotmap` of `__dunder__ -> (_size, _location, _index)`, where `_size = sizeof(tp_as_type) / sizeof(void *)`, `_location = offsetof(PyTypeObject, tp_as_type)` and `_index = offsetof(tp_as_type, tp_dunder)`. This meant that later, inside of a hook function, I could allocated a needed `tp_as_type` structure using `_size`, place the pointer to the structure as needed using `_location`, and place the given slot pointer using `_index`. If `_location` was `0`, then the `tp_dunder` existed on the main instance, not on a substructure.

`orig` at this point consisted of a basic cache of the hooked `slot wrapper` instances, and would use some frame inspection to determine which was the correct one when called.

This system served its purposes pretty well for the first version of fishhook, but I still wanted to find a way to calculate the `tp_as_type` structure locations. At this point, they, along with the offset into `PyWrapperDescrObject` for grabbing `offset`, were the only hardcoded values. However, I was stuck on that for several months, and in the meantime made many quality of life improvements and patches to fishhook.

I finally determined a way to calculate the offsets and sizes of each `tp_as_type` structure when looking back over the definition of `PyHeapTypeObject`. I realized that I could find the locations of each structure by reading the memory of an entire instance of `PyHeapTypeObject` and looking for pointers that pointed into the object. With those pointers, I could calculate both the sizes and locations of each substructure in one pass. 

```py
# (Notes from my research)
# A-E are unknown size arrays

'''
(PyHeapTypeObject) [
  (PyTypeObject) [
  ...
  -> A
  ...
  -> C
  -> B
  -> D
  ...
  -> E
  ]
  A
  B
  C
  D
  E
  ...
]
'''

# 1. Collect ptr values to get starting addresses of A-E
#    by looking for pointers that direct within PyHeapTypeObject
from ctypes import (
    sizeof,
    c_void_p,
    c_char
)

basic_size = sizeof(c_void_p)

def mem(addr, size):
    return (c_char*size).from_address(addr)

class HeapTypeObj:
    __slots__ = ()

size = type(HeapTypeObj).__sizeof__(HeapTypeObj)
static_size = type.__sizeof__(type)
cls_mem = mem(id(HeapTypeObj), size).raw
address = id(HeapTypeObj)
pointers = [(offset, ptr) for offset, ptr in enumerate(memoryview(cls_mem).cast('l'))
                if address < ptr < address + len(cls_mem)]

# 2. Get Differences between ptr[B]-ptr[A], ... to get sizes
sizes = []
last_addr = None
for offset, ptr in sorted(pointers, key=lambda i:i[1]):
    if last_addr is not None:
        sizes.append(ptr - last_addr)
    last_addr = ptr

sizes.append(last_addr - ptr + len(cls_mem))

# 3. We now know the offsets and sizes of ptr[A-E] in PyTypeObject
structs = [(0, static_size)] \
        + [(offset, size) for (offset, _), size in zip(pointers, sizes)]
```

Once I had those values, I was able to make almost all of fishhook fully dynamic, and it even worked without any changes when Python updated from 3.9 to 3.10, despite a new dunder being added to `tp_as_async`

## Major Version 2

The second major version of fishhook came with major changes internally. When `3.10` released, there was a new type flag `Py_TPFLAGS_IMMUTABLETYPE` that I noticed and started researching. In the process of this research, I found another semi-similar flag, `Py_TPFLAGS_HEAPTYPE`. I determined that with some minor coercion, I could toggle these flags, and convince the CPython implementation to swap all of the pointers I needed, negating the need for the large subclass loop from version one. The substructure size and locations were still important however, as I needed to allocate those on-demand prior to toggling flags.

Once I implemented these flags, I was able to get rid of a lot of the code that handled raw C pointers, and I spent a lot of time redesiging the strategy I used for calling original dunders. Now my solution walks back subclasses as well, so a hooked subclass's orig call will call its parent classes dunder automatically.

I was also able to overcome another bug in version two, that actually stems from an assumption (bug?) in CPython. In CPython it is assumed that if `tp_as_type` structures are set, that the class must be a *subclass* of object. During execution, there are places that if a given `tp_as_type` is set, then `tp_base->*properties*` will be blindly accessed. This assumption is violated by fishhook when the base type `object` is hooked. Normally `object` has no `tp_as_type` substructures, and a null `tp_base`. When hooked, it suddenly has `tp_as_type` structures, and eventually, you run into a nasty crash. My solution for this was to manifest a fake base class, that `object->tp_base` would point to. This base class would have nearly nothing set, just the bare things needed for things to skip passed it when calculating inheritance. I also added a fake property to `object.__base__` that returns `None`, to make it so that for normal code, `object` still appears to be the root base class.

After that fix, there were some small fixes for `3.12` involving the new feature of managed instance dictionaries, where I have to forcibly remove invalid ones, but thats it. Version two is still the current strategy, and it works fairly well.

The source code for fishhook can be found on github [here](https://github.com/chilaxan/fishhook/)